// Hosted engines: one Chromium, one browser context (cookie jar) per Figma account, closed after idle minutes and
// least recently used first past `maxAccounts` (each after its running calls). Calls for one account run one at a time.
// Memory: each open file is ~2 GB, so the ceiling is maxAccounts × maxFiles × 2 GB.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CATALOG_TTL, createEngine, isAlive, useStaticCache } from './engine.js';
import { CHROMIUM_ARGS, CONTEXT_OPTIONS, WARM, isSignedOut } from './figma.js';
import { playwrightCookies } from './session.js';

/**
 * @param {{ log: import('./figma.js').Log, putAsset: import('./engine.js').PutAsset, idleMs?: number,
 *   maxAccounts?: number, maxFiles?: number, cacheDir?: string,
 *   openEngine?: (cookies: import('./figma.js').Cookie[]) => Promise<import('./engine.js').Engine>, warmRecent?: boolean }} options
 *   maxFiles: open files per account; openEngine: a browser context with these cookies, and its engine
 */
export function createPool({
  log,
  putAsset,
  idleMs = Number(process.env.IDLE_MINUTES || 30) * 60_000,
  maxAccounts = Number(process.env.MAX_ACCOUNTS || 6),
  maxFiles = Number(process.env.MAX_FILES || 2),
  cacheDir = process.env.STATIC_CACHE_DIR || join(homedir(), '.cache', 'figma-remote-mcp'),
  openEngine,
  warmRecent = WARM,
}) {
  /** @type {Promise<import('playwright').Browser> | null} */
  let browser = null;
  /** Figma's tool list, shared by every account for an hour: it differs only by feature flags, and listing it then
   * never waits for an editor to load. @type {{ at: number, tools: import('./engine.js').Tool[] } | null} */
  let catalog = null;
  /** @type {Map<string, { engine: Promise<import('./engine.js').Engine>, queue: Promise<unknown>, used: number, timer?: NodeJS.Timeout }>} */
  const accounts = new Map();

  const open =
    openEngine ??
    (async (/** @type {import('./figma.js').Cookie[]} */ cookies) => {
      const context = await (await launch()).newContext(CONTEXT_OPTIONS);
      await context.addCookies(/** @type {any} */ (playwrightCookies(cookies)));
      await useStaticCache(context, cacheDir);
      return createEngine({ context, putAsset, log, maxPages: maxFiles });
    });

  const launch = () =>
    (browser ??= chromium.launch({ headless: true, args: CHROMIUM_ARGS }).then((b) => {
      b.on('disconnected', () => {
        browser = null;
        for (const id of [...accounts.keys()]) accounts.delete(id);
      });
      return b;
    }));

  /**
   * Closes an account's context once its queued calls are done: eviction or idleness never cuts a call short. A call
   * arriving meanwhile starts a fresh entry.
   * @param {string} id
   */
  function closeAccount(id) {
    const a = accounts.get(id);
    if (!a) return Promise.resolve();
    accounts.delete(id);
    clearTimeout(a.timer);
    return a.queue.then(async () => (await a.engine.catch(() => null))?.close());
  }

  /** A browser context with the account's cookies, and its engine @param {string} id @param {import('./figma.js').Cookie[]} cookies */
  function start(id, cookies) {
    const started = Date.now();
    const engine = open(cookies).then((e) => {
      log.info(`pool: account context ready in ${Date.now() - started}ms (${accounts.size} active)`);
      return e;
    });
    engine.catch(() => accounts.get(id)?.engine === engine && accounts.delete(id));
    return engine;
  }

  /** @param {string} id @param {import('./figma.js').Cookie[]} cookies */
  function account(id, cookies) {
    let a = accounts.get(id);
    if (!a) {
      while (accounts.size >= maxAccounts) {
        const [oldest] = [...accounts].sort((x, y) => x[1].used - y[1].used)[0];
        log.info('pool: closing the least recently used account (after its calls)');
        void closeAccount(oldest);
      }
      a = { engine: start(id, cookies), queue: Promise.resolve(), used: Date.now() };
      accounts.set(id, a);
    }
    a.used = Date.now();
    clearTimeout(a.timer);
    a.timer = setTimeout(() => void closeAccount(id).then(() => log.info('pool: closed an idle account')), idleMs);
    a.timer.unref();
    return a;
  }

  return {
    /**
     * Runs `fn` on the account's engine, after the account's earlier calls. A sign-out seen by the engine (its cookies
     * expired while the caller's are fresh) restarts it once from the caller's cookies.
     * @template T @param {string} id Figma user id @param {import('./figma.js').Cookie[]} cookies
     * @param {(engine: import('./engine.js').Engine) => Promise<T>} fn @returns {Promise<T>}
     */
    run(id, cookies, fn) {
      const a = account(id, cookies);
      const run = a.queue.then(async () => {
        const restart = () => {
          const old = a.engine;
          a.engine = start(id, cookies);
          // the entry may have left the map meanwhile (Chrome disconnected, a failed start): put it back, so its
          // context is still idle-closed and evicted like any other
          if (accounts.get(id) !== a) {
            const other = accounts.get(id);
            accounts.set(id, a);
            if (other) void other.queue.then(() => other.engine.then((e) => e.close(), () => {}));
          }
          void old.then((e) => e.close(), () => {});
        };
        // the browser behind it died: a new context first
        if (!(await a.engine.then(isAlive, () => false))) restart();
        try {
          return await fn(await a.engine);
        } catch (err) {
          if (!isSignedOut(err)) throw err;
          restart(); // in place, so the retry stays in this account's queue
          return fn(await a.engine);
        }
      });
      a.queue = run.catch(() => {});
      return run;
    },
    /** Figma's tools: the shared list, or this account's (which then becomes the shared one).
     * @param {string} id @param {import('./figma.js').Cookie[]} cookies */
    async tools(id, cookies) {
      if (catalog && Date.now() - catalog.at < CATALOG_TTL) return catalog.tools;
      const tools = await this.run(id, cookies, (e) => e.tools());
      catalog = { at: Date.now(), tools };
      return tools;
    },
    /** Starts an account's browser context ahead of its first call (initialize does this). @param {string} id @param {import('./figma.js').Cookie[]} cookies */
    warm(id, cookies) {
      account(id, cookies).engine.then(
        (e) => warmRecent && e.warm(),
        (err) => log.warn(`pool: warm-up failed: ${err?.message ?? err}`),
      );
    },
    async close() {
      for (const id of [...accounts.keys()]) await closeAccount(id);
      await (await browser?.catch(() => null))?.close();
    },
  };
}

