// The engine: figma.com's editor in a browser context that holds one Figma account's session, with the desktop shim
// installed, so the page runs the tools plugin (Figma's Plugin API) and, with --dev-mode, Figma Desktop's MCP tools.
// One page per open file (the tools act on the page's file, as the desktop's act on its active tab), least recently
// used pages closed past `maxPages`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FIGMA, figmaError, fileUrl, parseFile, signedOutError } from './figma.js';
import { isReadTool, pluginRequest, pluginResult } from './plugin-tools.js';
import { desktopShim } from './shim.js';

// The tools plugin (src/plugin, figma-mcp-rust's MIT plugin), served to the page as local plugin 1. Its UI is a stub:
// requests go to its main thread directly (see the shim), so the bundled UI's WebSocket client isn't needed.
const PLUGIN = {
  manifest: readFileSync(new URL('./plugin/manifest.json', import.meta.url), 'utf8'),
  code: readFileSync(new URL('./plugin/code.js', import.meta.url), 'utf8'),
  html: '<!doctype html><title>figma-remote-mcp</title>',
};
const PLUGIN_TIMEOUT = 120_000;
// A long-lived editor grows (Figma's draw loop, sync socket): a page this old is closed at its next use and the file
// opened again (that call pays a cold open).
const MAX_PAGE_AGE = 4 * 3_600_000;
// The editor renders for nobody: a small viewport costs less, and Figma's analytics/telemetry need not run at all
// (A/B, 88-page file: cold opens 17.8/19.4 s with these, 21.8/20.1 s without).
const VIEWPORT = { width: 640, height: 400 };
const TELEMETRY = /(datadoghq|sentry\.io|segment\.(io|com)|statsig|amplitude|fullstory|google-analytics|googletagmanager|doubleclick|\/api\/web_logger|\/api\/figment-proxy)/;
// Waiting for Figma to confirm a page's edits are saved before freezing or closing it gives up after this long.
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
/** The page reloaded, navigated, crashed or closed under a call (Playwright's wording) */
const pageGone = (/** @type {unknown} */ err) =>
  /context was destroyed|Target closed|crashed|has been closed|frame was detached|Execution context|navigat/i.test(messageOf(err));
/** The page itself is gone (crashed or closed): nothing more can run in it */
const pageDead = (/** @type {import('playwright').Page} */ page, /** @type {unknown} */ err) => page.isClosed() || /crashed|has been closed|Target closed/i.test(messageOf(err));
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
  await context.route(TELEMETRY, (r) => r.abort());
  /**
   * Open files. An entry is in the map from the moment its file starts opening, so two callers (the warm-up and a call)
   * share one page. @type {Map<string, { opening: Promise<import('playwright').Page>, used: number, openedAt: number }>}
   */
  const pages = new Map();
  /** The file a call without `fileKey` works on: the last one used. @type {{ key: string, editor: string } | null} */
  let current = null;
  /** @type {{ at: number, tools: Tool[] } | null} */
  let catalog = null;
  let closed = false;
  context.on('close', () => (closed = true)); // the browser died or was closed: this engine is done

  /** @type {WeakMap<import('playwright').Page, { cdp: Promise<import('playwright').CDPSession>, frozen: boolean, busy: number, timer?: NodeJS.Timeout }>} */
  const lifecycle = new WeakMap();
  /**
   * Runs `fn` with the page awake; the page freezes FREEZE_AFTER after its last use, once its edits are saved.
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

  /** Waits (up to SAVE_TIMEOUT) until the page's changes have reached Figma. Only call on an awake page. @param {import('playwright').Page} page */
  async function untilSaved(page) {
    const deadline = Date.now() + SAVE_TIMEOUT;
    while (Date.now() < deadline && !page.isClosed()) {
      if (await page.evaluate(() => /** @type {any} */ (window).__figmaRemote?.saved() ?? true).catch(() => true)) return;
      await sleep(250);
    }
    if (!page.isClosed()) log.warn('a file still had unsaved changes after 15s; closing it anyway');
  }
  /** Closes a page once its changes are saved (woken first: a frozen page runs no script) @param {import('playwright').Page} page */
  const closePage = async (page) => {
    if (page.isClosed()) return;
    await awake(page, () => untilSaved(page)).catch(() => {});
    await page.close().catch(() => {});
  };
  /** Drops a file's page from the pool and closes it, so the next call opens the file afresh @param {string} key @param {import('playwright').Page} page */
  const forget = (key, page) => {
    const entry = pages.get(key);
    if (entry) entry.opening.then((p) => p === page && pages.get(key) === entry && pages.delete(key), () => {});
    void closePage(page);
  };

  const signedOut = (/** @type {import('playwright').Page} */ page) => /^\/(login|signup)\b/.test(new URL(page.url()).pathname);
  /**
   * Signed out, Figma leaves the file URL in place and never starts the editor: so while a page isn't ready, ask
   * Figma directly (every 5 s). Throws the sign-out.
   * @param {import('playwright').Page} page @param {{ at: number }} next
   */
  async function assertSignedIn(page, next) {
    if (signedOut(page)) throw signedOutError();
    if (Date.now() < next.at) return;
    next.at = Date.now() + 5_000;
    const status = await context.request.get(`${FIGMA}/api/session/check`).then((r) => r.status(), () => 0);
    if (status === 401) throw signedOutError();
  }
  const gone = () => figmaError('gone', "Figma's editor page crashed or closed.");

  /** Waits until the page's desktop handler answers: the file is open and its tools run. @param {import('playwright').Page} page */
  async function whenReady(page) {
    const deadline = Date.now() + OPEN_TIMEOUT;
    const check = { at: Date.now() + 5_000 };
    let last = '';
    while (Date.now() < deadline) {
      if (page.isClosed()) throw gone();
      await assertSignedIn(page, check);
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
        if (pageDead(page, err)) throw gone();
        last = pageGone(err) ? last : pageMessage(err);
      }
      await sleep(500);
    }
    throw figmaError('unavailable', `The file did not open in Figma's editor${last ? ` (${last})` : ''}. Check the file key and that this account can open it.`);
  }

  /** The page for a file, opened when needed (and again when it crashed or got old) @param {{ key: string, editor: string }} file */
  async function pageFor(file) {
    const open = pages.get(file.key);
    if (open) {
      const page = await open.opening.catch(() => null);
      if (page && !page.isClosed() && Date.now() - open.openedAt <= MAX_PAGE_AGE) {
        open.used = Date.now();
        return page;
      }
      if (pages.get(file.key) === open) pages.delete(file.key);
      if (page && !page.isClosed()) {
        log.info(`recycling a file page after ${Math.round((Date.now() - open.openedAt) / 3_600_000)}h`);
        await closePage(page);
      }
      if (pages.has(file.key)) return pageFor(file); // someone else reopened it meanwhile
    }
    while (pages.size >= maxPages) {
      const [key, oldest] = [...pages].sort((a, b) => a[1].used - b[1].used)[0];
      pages.delete(key);
      void oldest.opening.then(closePage, () => {});
    }
    const started = Date.now();
    /** @type {{ opening: Promise<import('playwright').Page>, used: number, openedAt: number }} */
    const entry = { opening: Promise.resolve(/** @type {any} */ (null)), used: started, openedAt: started };
    entry.opening = (async () => {
      const page = await context.newPage();
      // A crashed page leaves the pool; the next call opens the file again.
      page.on('crash', () => {
        log.warn('a file page crashed; it reopens on the next call');
        if (pages.get(file.key) === entry) pages.delete(file.key);
        void page.close().catch(() => {});
      });
      try {
        await page.setViewportSize(VIEWPORT);
        await page.goto(fileUrl(file), { waitUntil: 'domcontentloaded', timeout: OPEN_TIMEOUT });
        await awake(page, () => whenReady(page));
      } catch (err) {
        await page.close().catch(() => {});
        throw err;
      }
      log.info(`opened a file in ${Date.now() - started}ms`);
      return page;
    })();
    pages.set(file.key, entry);
    entry.opening.catch(() => pages.get(file.key) === entry && pages.delete(file.key));
    return entry.opening;
  }

  /**
   * One query to the page's desktop handler; once more after a reload (Figma reloads the editor on new releases).
   * @param {import('playwright').Page} page @param {string} tool @param {unknown} args @param {ClientInfo} clientInfo
   */
  async function query(page, tool, args, clientInfo) {
    const run = () =>
      awake(page, () =>
        page.evaluate(([t, a, c]) => /** @type {any} */ (window).__figmaRemote.query(t, a, c), /** @type {const} */ ([tool, args, clientInfo])),
      );
    try {
      return await run();
    } catch (err) {
      if (pageDead(page, err) || (!pageGone(err) && !/not registered its desktop handler/.test(messageOf(err)))) throw err;
      await awake(page, () => whenReady(page));
      return run();
    }
  }

  /** @type {WeakMap<import('playwright').Page, Promise<void>>} */
  const pluginStarts = new WeakMap();
  /**
   * The file's page with the tools plugin running. One start at a time per page (a warm-up and a call may ask together).
   * @param {{ key: string, editor: string }} file
   */
  async function pluginPage(file) {
    const page = await pageFor(file);
    let starting = pluginStarts.get(page);
    if (!starting) {
      starting = startPlugin(page).finally(() => pluginStarts.delete(page));
      pluginStarts.set(page, starting);
    }
    await starting;
    return page;
  }

  /**
   * Starts the tools plugin unless it is running: waits for Figma to load the document and allow plugins in it (the
   * plugin manager drops a plugin started earlier), then runs it, and again if it stays silent for 10 s.
   * @param {import('playwright').Page} page
   */
  async function startPlugin(page) {
    await awake(page, async () => {
      const waitStarted = Date.now();
      const deadline = Date.now() + OPEN_TIMEOUT;
      const check = { at: Date.now() + 10_000 };
      let startedAt = 0;
      let loadedAt = 0;
      let last = '';
      while (Date.now() < deadline) {
        if (page.isClosed()) throw gone();
        await assertSignedIn(page, check);
        let s = null;
        try {
          s = await page.evaluate(() => {
            const r = /** @type {any} */ (window).__figmaRemote;
            return { running: r.pluginRunning(), allowed: r.pluginsAllowed(), file: r.fileState() };
          });
        } catch (err) {
          if (pageDead(page, err)) throw gone();
          // anything else while the page loads (a reload, Figma's code not there yet) is transient: keep waiting
          last = pageGone(err) ? last : pageMessage(err);
        }
        if (s?.running) {
          if (startedAt) log.info(`plugin ready in ${Date.now() - waitStarted}ms`);
          return;
        }
        // Figma reports the file loaded a moment before its permissions (canEdit reads false until then).
        if (s?.file.loaded) loadedAt ||= Date.now();
        if (s?.file.loaded && !s.allowed && (s.file.canRunExtensions === false || (s.file.canEdit === false && Date.now() - loadedAt > 15_000))) {
          throw figmaError('forbidden', "Figma doesn't run plugins in this file for this account (it is view-only, or plugins are turned off). Ask for edit access, or duplicate the file to your drafts.");
        }
        if (startedAt && Date.now() - startedAt > 10_000) startedAt = 0; // Figma dropped the run, or the page reloaded
        if (s?.allowed && !startedAt) {
          startedAt = await page.evaluate(() => /** @type {any} */ (window).__figmaRemote.runPlugin(1)).then(() => Date.now(), () => 0);
        }
        await sleep(300);
      }
      throw figmaError('unavailable', `The tools plugin didn't start in Figma's editor${last ? ` (${last})` : ''}. Try again.`);
    });
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

  /** The account's most recently opened file */
  async function recentFile() {
    const res = await context.request.get(`${FIGMA}/api/recent_files`);
    if (res.status() === 401) throw signedOutError();
    const files = (await res.json().catch(() => null))?.meta?.recent_files ?? [];
    const key = files.find((/** @type {any} */ f) => typeof f?.key === 'string' && !f.trashed_user_id)?.key;
    if (!key) throw figmaError('unavailable', 'This Figma account has no recent files. Open any design file in Figma once.');
    return { key, editor: 'design' };
  }

  const TIMED_OUT = Symbol('timeout');

  return {
    /** Figma's Dev Mode tools (--dev-mode), from an open file's page (cached for an hour). @returns {Promise<Tool[]>} */
    async tools() {
      if (catalog && Date.now() - catalog.at < CATALOG_TTL) return catalog.tools;
      const open = [...pages.values()][0];
      const page = open && (await open.opening.catch(() => null));
      if (page && !page.isClosed()) {
        const listed = await query(page, 'internal_get_tools', undefined, { name: 'figma-remote-mcp' });
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
     * Runs one of Figma's Dev Mode tools on the file `args.fileKey` names (a key or a figma.com URL), or the last one
     * used. Figma's refusals (seat, permissions, rate limit, a bad node) come back as tool errors, in Figma's words.
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
      // Dev Mode tools only read: a crashed page is reopened and the call made once more.
      for (let attempt = 0; ; attempt++) {
        let page;
        try {
          page = await pageFor(file);
        } catch (err) {
          if (/** @type {any} */ (err)?.code === 'gone' && attempt === 0) continue;
          throw err;
        }
        current = file;
        let result;
        try {
          result = await query(page, tool, pass, clientInfo);
        } catch (err) {
          if (signedOut(page)) throw signedOutError();
          if (pageDead(page, err) && attempt === 0) {
            forget(file.key, page);
            continue;
          }
          return errorResult(pageMessage(err));
        }
        if (!result || !Array.isArray(result.content)) {
          return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? null) }] };
        }
        return resolveAssets(result, (name) => awake(page, () => page.evaluate((n) => /** @type {any} */ (window).__figmaRemote.image(n), name)), putAsset, log);
      }
    },

    /**
     * Runs one of the plugin tools (Figma's Plugin API) on the file `args.fileKey` names, or the last one used.
     * A request is sent once. Before it is sent, a crashed or closed page is simply reopened; once sent, a read is run
     * again after a crash or reload, and a write is reported as uncertain (never sent twice). A request that times out
     * closes the page, so a hung plugin starts fresh next time.
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
      const uncertain = `Figma's editor reloaded, crashed or stalled while ${tool} ran, so it may or may not have been applied. Check the file before running it again.`;
      for (let attempt = 0; ; attempt++) {
        let page;
        try {
          page = await pluginPage(file);
        } catch (err) {
          const code = /** @type {any} */ (err)?.code;
          if (code === 'forbidden') return errorResult(messageOf(err));
          if (code === 'gone' && attempt < 2) continue; // nothing was sent yet
          throw err;
        }
        current = file;
        /** @type {any} */
        let response;
        try {
          response = await awake(page, () =>
            Promise.race([page.evaluate((r) => /** @type {any} */ (window).__figmaRemote.request(r), request), sleep(PLUGIN_TIMEOUT).then(() => TIMED_OUT)]),
          );
        } catch (err) {
          if (!pageGone(err)) return errorResult(pageMessage(err));
          if (pageDead(page, err)) forget(file.key, page);
          if (isReadTool(tool) && attempt === 0) {
            log.warn(`${tool}: the editor reloaded or crashed; running it again`);
            continue;
          }
          return errorResult(uncertain);
        }
        if (response === TIMED_OUT) {
          forget(file.key, page); // a hung plugin (or editor) starts fresh on the next call
          return errorResult(isReadTool(tool) ? `${tool} took longer than ${PLUGIN_TIMEOUT / 1000}s.` : uncertain);
        }
        return pluginResult(tool, response);
      }
    },

    /** Opens the account's most recently opened file in the background, so the likely first call finds it warm. */
    warm() {
      if (pages.size) return;
      recentFile()
        .then((file) => pluginPage(file))
        .then(() => log.info('warmed the most recent file'))
        .catch((err) => log.warn(`warm-up: ${messageOf(err)}`));
    },

    /** False once the browser behind this engine has gone (crashed or closed) */
    get alive() {
      return !closed;
    },

    async close() {
      for (const { opening } of [...pages.values()]) await opening.then(closePage, () => {});
      pages.clear();
      await context.close().catch(() => {});
    },
  };
}

/** @typedef {Awaited<ReturnType<typeof createEngine>>} Engine */
/** Whether an engine's browser is still there (a test double without `alive` counts as alive) @param {{ alive?: boolean }} engine */
export const isAlive = (engine) => engine.alive !== false;
