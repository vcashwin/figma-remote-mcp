// The engine: figma.com's editor in a browser context that holds one Figma account's session, with the desktop shim
// installed, so the page runs the tools plugin (Figma's Plugin API) and, with --dev-mode, Figma Desktop's MCP tools. One page per open file (the tools act on the page's
// file, as the desktop's act on its active tab), least recently used pages closed past `maxPages`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIGMA, figmaError, fileUrl, parseFile, signedOutError } from './figma.js';
import { pluginRequest, pluginResult } from './plugin-tools.js';
import { desktopShim } from './shim.js';

// The tools plugin (src/plugin, figma-mcp-rust's MIT plugin), served to the page as local plugin 1. Its UI is a stub:
// requests go to its main thread directly (see the shim), so the bundled UI's WebSocket client isn't needed.
const PLUGIN = {
  manifest: readFileSync(new URL('./plugin/manifest.json', import.meta.url), 'utf8'),
  code: readFileSync(new URL('./plugin/code.js', import.meta.url), 'utf8'),
  html: '<!doctype html><title>figma-remote-mcp</title>',
};
const PLUGIN_TIMEOUT = 120_000;
const SAVE_TIMEOUT = 15_000;

const OPEN_TIMEOUT = 90_000;
// An open editor renders continuously (about 2.5 cores under SwiftShader, idle); frozen it costs a fraction. Pages
// freeze this long after their last use and wake for the next call (in milliseconds).
const FREEZE_AFTER = 5_000;
export const CATALOG_TTL = 3_600_000;
const ASSET_LINK = /http:\/\/localhost:3845\/assets\/([A-Za-z0-9._-]+)/g;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp' };

/** @typedef {{ name: string, version?: string }} ClientInfo */
/** @typedef {{ name: string, description?: string, inputSchema: { type: string, properties?: Record<string, any>, required?: string[] }, [k: string]: unknown }} Tool */
/** @typedef {{ content: any[], isError?: boolean, [k: string]: unknown }} ToolResult */
/** @typedef {(name: string, base64: string, mime: string) => string} PutAsset  stores an image, returns its URL */

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const messageOf = (/** @type {unknown} */ err) => String(err instanceof Error ? err.message : err);
const navigating = (/** @type {unknown} */ err) =>
  /context was destroyed|Target closed|frame was detached|Execution context|navigat/i.test(messageOf(err));
/** The page's own error text, without Playwright's wrapping @param {unknown} err */
const pageMessage = (err) => messageOf(err).replace(/^page\.evaluate: (Error: )?/, '').split('\n    at ')[0];
/** @param {string} text @returns {ToolResult} */
export const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * Serves figma.com's immutable static assets (the editor's JS, WASM and fonts: tens of MB) from a disk cache shared by
 * every context, so a fresh account's first file opens without downloading the editor again.
 * @param {import('playwright').BrowserContext} context @param {string} dir
 */
export async function useStaticCache(context, dir) {
  await mkdir(dir, { recursive: true });
  const at = (/** @type {string} */ url) => join(dir, createHash('sha256').update(url).digest('hex'));
  await context.route(/^https:\/\/(www\.figma\.com\/webpack-artifacts|static\.figma\.com)\//, async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.continue();
    const file = at(request.url());
    const hit = await readFile(`${file}.json`, 'utf8').catch(() => null);
    if (hit) {
      const body = await readFile(file).catch(() => null);
      if (body) return route.fulfill({ status: 200, headers: JSON.parse(hit), body });
    }
    const response = await route.fetch().catch(() => null);
    if (!response) return route.abort();
    const headers = { ...response.headers() };
    delete headers['content-encoding']; // route.fetch() hands back the decoded body
    delete headers['content-length'];
    const body = await response.body();
    if (response.status() === 200 && /immutable|max-age=(\d{6,})/.test(headers['cache-control'] ?? '')) {
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, body)
        .then(() => rename(tmp, file))
        .then(() => writeFile(`${file}.json`, JSON.stringify(headers)))
        .catch(() => {});
    }
    return route.fulfill({ status: response.status(), headers, body });
  });
}

/**
 * A result's Figma assets: each http://localhost:3845/assets/<name> link the page wrote is fetched from the page right
 * away (it keeps only the latest call's) and replaced with the URL `putAsset` gives. A link that can't be fetched stays.
 * @param {ToolResult} result @param {(name: string) => Promise<string>} image base64 bytes of an asset
 * @param {PutAsset} putAsset @param {import('./figma.js').Log} log @returns {Promise<ToolResult>}
 */
export async function resolveAssets(result, image, putAsset, log) {
  /** @type {Map<string, string>} */
  const urls = new Map();
  for (const item of result.content) {
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    for (const [, name] of item.text.matchAll(ASSET_LINK)) {
      if (urls.has(name)) continue;
      try {
        const ext = /** @type {keyof typeof MIME} */ (name.split('.').pop()?.toLowerCase() ?? '');
        urls.set(name, putAsset(name, await image(name), MIME[ext] ?? 'application/octet-stream'));
      } catch (err) {
        urls.set(name, '');
        log.warn(`asset ${name}: ${pageMessage(err)}`);
      }
    }
  }
  if (!urls.size) return result;
  const rewrite = (/** @type {string} */ text) => text.replace(ASSET_LINK, (link, /** @type {string} */ name) => urls.get(name) || link);
  return { ...result, content: result.content.map((item) => (item?.type === 'text' ? { ...item, text: rewrite(item.text) } : item)) };
}

/**
 * @param {{
 *   context: import('playwright').BrowserContext,
 *   putAsset: PutAsset,
 *   log: import('./figma.js').Log,
 *   maxPages?: number,
 * }} options
 */
export async function createEngine({ context, putAsset, log, maxPages = 3 }) {
  await context.addInitScript(desktopShim, [PLUGIN]);
  /** @type {Map<string, { page: import('playwright').Page, opening: Promise<void>, used: number }>} */
  const pages = new Map();
  /** The file a call without `fileKey` works on: the last one used. @type {{ key: string, editor: string } | null} */
  let current = null;
  /** @type {{ at: number, tools: Tool[] } | null} */
  let catalog = null;

  /** @type {WeakMap<import('playwright').Page, { cdp: Promise<import('playwright').CDPSession>, frozen: boolean, busy: number, timer?: NodeJS.Timeout }>} */
  const lifecycle = new WeakMap();
  /**
   * Runs `fn` with the page awake; the page freezes FREEZE_AFTER after its last use.
   * @template T @param {import('playwright').Page} page @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  async function awake(page, fn) {
    let s = lifecycle.get(page);
    if (!s) lifecycle.set(page, (s = { cdp: context.newCDPSession(page), frozen: false, busy: 0 }));
    const state = s;
    clearTimeout(state.timer);
    state.busy++;
    try {
      if (state.frozen) {
        await (await state.cdp).send('Page.setWebLifecycleState', { state: 'active' });
        state.frozen = false;
      }
      return await fn();
    } finally {
      if (--state.busy === 0 && !page.isClosed()) {
        state.timer = setTimeout(async () => {
          if (state.busy || page.isClosed()) return;
          await untilSaved(page);
          if (state.busy || page.isClosed()) return;
          await (await state.cdp).send('Page.setWebLifecycleState', { state: 'frozen' }).then(() => (state.frozen = true), () => {});
        }, FREEZE_AFTER);
        state.timer.unref();
      }
    }
  }

  /** Waits (up to SAVE_TIMEOUT) until the page's changes have reached Figma, so freezing or closing loses nothing. @param {import('playwright').Page} page */
  async function untilSaved(page) {
    const deadline = Date.now() + SAVE_TIMEOUT;
    while (Date.now() < deadline && !page.isClosed()) {
      if (await page.evaluate(() => /** @type {any} */ (window).__figmaRemote?.saved() ?? true).catch(() => true)) return;
      await sleep(250);
    }
    if (!page.isClosed()) log.warn('a file still had unsaved changes after 15s');
  }
  /** Closes a page once its changes are saved @param {import('playwright').Page} page */
  const closePage = async (page) => {
    await untilSaved(page);
    await page.close().catch(() => {});
  };

  const signedOut = (/** @type {import('playwright').Page} */ page) => /^\/(login|signup)\b/.test(new URL(page.url()).pathname);

  /** Waits until the page's desktop handler answers: the file is open and its tools run. @param {import('playwright').Page} page */
  async function whenReady(page) {
    const deadline = Date.now() + OPEN_TIMEOUT;
    let last = '';
    let checkAt = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (signedOut(page)) throw signedOutError();
      try {
        const tools = await page.evaluate(async () => {
          const w = /** @type {any} */ (window);
          if (!w.__figmaRemote) return null;
          const ready = await Promise.race([w.__figmaRemote.ready().then(() => true), new Promise((r) => setTimeout(r, 1000, false))]);
          return ready ? w.__figmaRemote.query('internal_get_tools', undefined, { name: 'figma-remote-mcp' }) : null;
        });
        if (tools?.tools) {
          catalog = { at: Date.now(), tools: tools.tools };
          return;
        }
      } catch (err) {
        last = navigating(err) ? last : pageMessage(err);
      }
      // Signed out, Figma leaves the file URL in place and never starts the editor: ask Figma directly.
      if (Date.now() > checkAt) {
        checkAt = Date.now() + 5_000;
        const status = await context.request.get(`${FIGMA}/api/session/check`).then((r) => r.status(), () => 0);
        if (status === 401) throw signedOutError();
      }
      await sleep(500);
    }
    throw figmaError('unavailable', `The file did not open in Figma's editor${last ? ` (${last})` : ''}. Check the file key and that this account can open it.`);
  }

  /** The page for a file, opened when needed @param {{ key: string, editor: string }} file */
  async function pageFor(file) {
    const open = pages.get(file.key);
    if (open && !open.page.isClosed()) {
      open.used = Date.now();
      await open.opening;
      return open.page;
    }
    while (pages.size >= maxPages) {
      const [key, oldest] = [...pages].sort((a, b) => a[1].used - b[1].used)[0];
      pages.delete(key);
      await closePage(oldest.page);
    }
    const page = await context.newPage();
    const started = Date.now();
    const opening = (async () => {
      await page.goto(fileUrl(file), { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT });
      await awake(page, () => whenReady(page));
    })();
    pages.set(file.key, { page, opening, used: Date.now() });
    try {
      await opening;
    } catch (err) {
      pages.delete(file.key);
      await page.close().catch(() => {});
      throw err;
    }
    log.info(`opened a file in ${Date.now() - started}ms`);
    return page;
  }

  /**
   * One query to the page's desktop handler; once more after a reload (Figma reloads the editor on new releases).
   * @param {import('playwright').Page} page @param {string} tool @param {unknown} args @param {ClientInfo} clientInfo
   */
  async function query(page, tool, args, clientInfo) {
    const run = () =>
      awake(page, () =>
        page.evaluate(
          ([t, a, c]) => /** @type {any} */ (window).__figmaRemote.query(t, a, c),
          /** @type {const} */ ([tool, args, clientInfo]),
        ),
      );
    try {
      return await run();
    } catch (err) {
      if (!navigating(err) && !/not registered its desktop handler/.test(messageOf(err))) throw err;
      await awake(page, () => whenReady(page));
      return run();
    }
  }

  /**
   * The file's page with the tools plugin running: waits for Figma to load the file and allow plugins in it, then
   * starts the plugin once per page.
   * @param {{ key: string, editor: string }} file
   */
  async function pluginPage(file) {
    const page = await pageFor(file);
    await awake(page, async () => {
      const deadline = Date.now() + OPEN_TIMEOUT;
      let started = false;
      let loadedAt = 0;
      while (Date.now() < deadline) {
        const s = await page
          .evaluate(() => {
            const r = /** @type {any} */ (window).__figmaRemote;
            return { running: r.pluginRunning(), allowed: r.pluginsAllowed(), file: r.fileState() };
          })
          .catch((err) => (navigating(err) ? null : Promise.reject(err)));
        if (s?.running) return;
        // Figma reports the file loaded a moment before its permissions (canEdit reads false until then).
        if (s?.file.loaded) loadedAt ||= Date.now();
        if (s?.file.loaded && !s.allowed && (s.file.canRunExtensions === false || (s.file.canEdit === false && Date.now() - loadedAt > 15_000))) {
          throw figmaError('forbidden', "Figma doesn't run plugins in this file for this account (it is view-only, or plugins are turned off). Ask for edit access, or duplicate the file to your drafts.");
        }
        if (s?.allowed && !started) {
          started = await page.evaluate(() => /** @type {any} */ (window).__figmaRemote.runPlugin(1)).then(() => true, () => false);
        }
        await sleep(300);
      }
      throw figmaError('unavailable', "The tools plugin didn't start in Figma's editor. Try again.");
    });
    return page;
  }

  /**
   * The file a call names with `fileKey` (a key or a figma.com URL), or the previous call's; the other arguments.
   * @param {Record<string, unknown>} args
   * @returns {{ file: { key: string, editor: string }, named: ReturnType<typeof parseFile>, rest: Record<string, unknown> } | { error: ToolResult }}
   */
  function resolveFile(args) {
    const { fileKey, ...rest } = args;
    const named = fileKey === undefined ? null : parseFile(fileKey);
    if (fileKey !== undefined && !named) return { error: errorResult('fileKey must be a Figma file key or a figma.com file URL (…/design/<fileKey>/…).') };
    const file = named ? { key: named.key, editor: named.editor } : current;
    if (!file) return { error: errorResult("Pass fileKey: the key from the file's URL (figma.com/design/<fileKey>/…) or the whole URL.") };
    return { file, named, rest };
  }

  /** The account's most recently opened file, for a catalog before any call named one. */
  async function recentFile() {
    const res = await context.request.get(`${FIGMA}/api/recent_files`);
    if (res.status() === 401) throw signedOutError();
    const files = (await res.json().catch(() => null))?.meta?.recent_files ?? [];
    const key = files.find((/** @type {any} */ f) => typeof f?.key === 'string' && !f.trashed_user_id)?.key;
    if (!key) {
      throw figmaError('unavailable', "This Figma account has no recent files to load Figma's tools from. Open any design file in Figma once.");
    }
    return { key, editor: 'design' };
  }

  return {
    /** Figma's tools, from an open file's page (cached for an hour). @returns {Promise<Tool[]>} */
    async tools() {
      if (catalog && Date.now() - catalog.at < CATALOG_TTL) return catalog.tools;
      const open = [...pages.values()].find((p) => !p.page.isClosed());
      if (open) {
        await open.opening;
        const listed = await query(open.page, 'internal_get_tools', undefined, { name: 'figma-remote-mcp' });
        catalog = { at: Date.now(), tools: listed.tools };
      } else {
        await pageFor(current ?? (await recentFile()));
      }
      return /** @type {{ tools: Tool[] }} */ (catalog).tools;
    },

    /** The file calls without `fileKey` use */
    get currentFile() {
      return current;
    },

    /**
     * Runs one of Figma's tools on the file `args.fileKey` names (a key or a figma.com URL), or the last one used.
     * Figma's refusals (seat, permissions, rate limit, a bad node) come back as tool errors, in Figma's words.
     * @param {string} tool @param {Record<string, unknown>} args @param {ClientInfo} clientInfo @param {Tool | undefined} def
     * @returns {Promise<ToolResult>}
     */
    async call(tool, args, clientInfo, def) {
      const resolved = resolveFile(args);
      if ('error' in resolved) return resolved.error;
      const { file, named, rest } = resolved;
      /** @type {Record<string, unknown>} */
      const pass = { ...rest };
      if (named?.nodeId && pass.nodeId === undefined) pass.nodeId = named.nodeId;
      if (def?.inputSchema?.properties?.fileKey) pass.fileKey = file.key;
      const page = await pageFor(file);
      current = file;
      let result;
      try {
        result = await query(page, tool, pass, clientInfo);
      } catch (err) {
        if (signedOut(page)) throw signedOutError();
        return errorResult(pageMessage(err));
      }
      if (!result || !Array.isArray(result.content)) {
        return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }] };
      }
      return resolveAssets(
        result,
        (name) => awake(page, () => page.evaluate((n) => /** @type {any} */ (window).__figmaRemote.image(n), name)),
        putAsset,
        log,
      );
    },

    /**
     * Runs one of the plugin tools (Figma's Plugin API) on the file `args.fileKey` names, or the last one used.
     * @param {string} tool @param {Record<string, unknown>} args @returns {Promise<ToolResult>}
     */
    async plugin(tool, args) {
      const resolved = resolveFile(args);
      if ('error' in resolved) return resolved.error;
      const { file, named, rest } = resolved;
      if (named?.nodeId && rest.nodeId === undefined && rest.nodeIds === undefined) rest.nodeId = named.nodeId;
      let request;
      try {
        request = pluginRequest(tool, rest);
      } catch (err) {
        return errorResult(messageOf(err));
      }
      let page;
      try {
        page = await pluginPage(file);
      } catch (err) {
        if (/** @type {any} */ (err)?.code === 'forbidden') return errorResult(messageOf(err));
        throw err;
      }
      current = file;
      const p = /** @type {import('playwright').Page} */ (page);
      const response = await awake(p, () =>
        Promise.race([
          p.evaluate((r) => /** @type {any} */ (window).__figmaRemote.request(r), request),
          sleep(PLUGIN_TIMEOUT).then(() => ({ error: `${tool} took longer than ${PLUGIN_TIMEOUT / 1000}s.` })),
        ]),
      ).catch((err) => ({ error: pageMessage(err) }));
      return pluginResult(tool, response);
    },

    async close() {
      for (const { page } of pages.values()) await closePage(page);
      pages.clear();
      await context.close().catch(() => {});
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof createEngine>>} Engine */
