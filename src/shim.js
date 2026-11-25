// The Figma desktop shell, as far as figma.com needs it for two things:
//  1. Figma Desktop's local MCP tools: figma.com checks for `window.__figmaDesktop` once, as its bundle loads, and
//     only then registers the desktop message handler that runs them (`sendMCPQuery`).
//  2. Development plugins: the desktop serves local plugins' manifests and code to the page
//     (getLocalManifestFileExtensionIdsToCachedMetadataMap, getLocalFileExtensionManifest/Source). We serve one, the
//     tools plugin (src/plugin), and run it the way Plugins › Development › <name> does.
// Installed before any page script (Playwright addInitScript). It emulates the shell only: Figma's seat, plan, admin
// and rate-limit checks still run, in the page and on Figma's servers.
//
// Self-contained: Playwright serialises the function (and its argument) into the page.

/** @param {{ manifest: string, code: string, html: string }[]} [plugins] local plugins, ids 1, 2, … */
export function desktopShim(plugins = []) {
  if (window.top !== window || location.origin !== 'https://www.figma.com') return;
  const w = /** @type {any} */ (window);
  if (w.__figmaRemote) return;

  /** @type {((name: string, args: any) => void) | null} */
  let handler = null;
  /** @type {() => void} */
  let registered = () => {};
  const ready = new Promise((r) => (registered = () => r(undefined)));
  /** @type {Map<string, { resolve(v: any): void, reject(e: Error): void }>} */
  const pending = new Map();
  let seq = 0;
  /** Whether the file has unsaved changes, as the page reports it to the shell (`setSaved`) */
  let saved = true;

  /** A reply the page posts back: `{ queryId, result: { result } | { error, errorObj } }` @param {any} args */
  const settle = (args) => {
    const p = pending.get(args?.queryId);
    if (!p) return;
    pending.delete(args.queryId);
    const r = args.result ?? {};
    if ('result' in r) p.resolve(r.result);
    else p.reject(new Error(String(r.error ?? r.errorObj?.message ?? 'Figma MCP query failed')));
  };

  // Local plugins as Figma Desktop's registry keeps them (numeric ids from 1).
  const local = (/** @type {number} */ id) => {
    const p = plugins[id - 1];
    if (!p) throw new Error('Unknown plugin');
    const m = JSON.parse(p.manifest);
    return { path: `/figma-remote/${id}/manifest.json`, lastKnownName: m.name, lastKnownPluginId: m.id || '', manifest: p.manifest, cachedContainsWidget: false };
  };
  const ids = () => plugins.map((_, i) => i + 1);

  // Promise calls the page makes, answered as a desktop without local fonts or a file system would. Anything else
  // rejects with "No result", which is what the real preload does for a name it lacks.
  /** @type {Record<string, (args: any) => unknown>} */
  const answers = {
    getFonts: () => ({}),
    getModifiedFonts: () => [],
    getFontsModifiedAt: () => 0,
    getZoomFactor: () => 1,
    getCPUUsage: () => ({ percent: 0, idleWakeupsPerSecond: 0 }),
    isDevToolsOpened: () => false,
    getCaptionsEnabled: () => false,
    spellingGetLanguages: () => [],
    isTabOpen: () => false,
    canOpenFigmaURL: () => false,
    getActiveNSScreens: () => [],
    getMcpClientSessions: () => [],
    getAllowedDirectoriesForMcp: () => [],
    getLocalManifestFileExtensionIdsToCachedMetadataMap: () =>
      Object.fromEntries(ids().map((id) => [id, { lastKnownPluginId: local(id).lastKnownPluginId, cachedContainsWidget: false }])),
    getLocalManifestFileExtensionIdsToCachedContainsWidgetMap: () => Object.fromEntries(ids().map((id) => [id, false])),
    getAllLocalManifestFileExtensionIds: () => ids(),
    getLocalFileExtensionManifest: ({ id }) => local(id),
    getLocalFileExtensionSource: ({ id }) => {
      local(id);
      const p = plugins[id - 1];
      return { stdout: '', stderr: '', path: '', source: p.code, html: p.html };
    },
    // The MCP server "is running": the page then just announces its tool list.
    setEnableMCP: ({ enabled } = {}) => ({ didStart: false, wasAlreadyRunning: !!enabled, port: 3845 }),
    writeFileToPathWithMcpAllowlist: () => {
      throw new Error('Writing files is not available here; images are served over HTTP.');
    },
  };

  w.__figmaDesktop = {
    version: 218,
    backportedApiFeatures: [],
    appVersion: '126.11.11',
    osVersion: '24.1.0',
    fileBrowser: false,
    concurrentLoadingTabsCount: undefined,
    clientID: crypto.randomUUID(),
    memoryInfo: { rendererSystemMemoryInfo: {}, rendererV8HeapStatistics: {} },
    isOverlayWindowAvailable: false,
    isGlobalEyedropperSupported: false,
    isScreenReaderEnabled: false,
    channel: 'stable',
    /** @param {string} name @param {any} args */
    postMessage(name, args) {
      if (name === 'sendMCPResult' || name === 'sendMCPImageResult') settle(args);
      else if (name === 'messageHandlerRegistered') registered();
      else if (name === 'setSaved') saved = args === true || args?.saved === true || args?.isSaved === true;
      // everything else is window chrome (titles, tabs, loading state): nothing to do
    },
    /** @param {string} name @param {any} args */
    promiseMessage(name, args) {
      const answer = answers[name];
      if (!answer) return Promise.reject(new Error('No result'));
      try {
        return Promise.resolve(answer(args ?? {}));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    registerCallback: () => () => {},
    /** @param {(name: string, args: any) => void} fn */
    setMessageHandler(fn) {
      handler = fn;
      this.postMessage('messageHandlerRegistered');
    },
  };

  /** A main-process message to the page, answered by its reply @param {string} name @param {object} args */
  const send = (name, args) =>
    new Promise((resolve, reject) => {
      if (!handler) return reject(new Error('Figma has not registered its desktop handler yet.'));
      const queryId = `fr-${++seq}`;
      pending.set(queryId, { resolve, reject });
      handler(name, { ...args, queryId });
    });
  /** @param {Uint8Array} bytes */
  const base64 = (bytes) => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };

  /** The page's module loader (its rspack JSONP runtime), modules found by a string in their source. */
  let req = /** @type {any} */ (null);
  /** @param {string} needle @param {(exports: any) => any} pick */
  const findExport = (needle, pick) => {
    if (!req) w.rspackChunk_figma_web_bundler.push([[`figma-remote-${Date.now()}`], {}, (/** @type {any} */ r) => (req = r)]);
    for (const id of Object.keys(req.m)) {
      if (!String(req.m[id]).includes(needle)) continue;
      let exports;
      try {
        exports = req(id);
      } catch {
        continue;
      }
      const found = pick(exports);
      if (found) return found;
    }
    throw new Error(`Figma's page changed: no module with "${needle}".`);
  };
  const store = () => findExport('setGlobalReduxStore', (e) => e?.globalReduxStore?.getState && e.globalReduxStore);

  // The running plugin's main thread, reached as its UI iframe reaches it: the plugin UI host's createInnerIframe gets
  // the handler that feeds figma.ui.onmessage, and the frame it returns receives what figma.ui.postMessage sends.
  /** @type {((m: any) => void) | null} */
  let toMain = null;
  /** @type {Map<string, (m: any) => void>} */
  const replies = new Map();
  let hooked = false;
  const hookUi = () => {
    if (hooked) return;
    const Host = findExport('Shim Plugin Iframe', (e) => Object.values(e).find((v) => /** @type {any} */ (v)?.prototype?.createInnerIframe));
    const create = Host.prototype.createInnerIframe;
    Host.prototype.createInnerIframe = function (/** @type {any[]} */ ...args) {
      const inner = create.apply(this, args);
      toMain = args[1];
      const post = inner.postMessage.bind(inner);
      inner.postMessage = (/** @type {any} */ msg, /** @type {any} */ opts) => {
        const m = msg?.pluginMessage;
        // progress frames carry the request id too; the answer is the frame without `progress`
        if (m?.requestId && !('progress' in m)) replies.get(m.requestId)?.(m);
        return post(msg, opts);
      };
      return inner;
    };
    hooked = true;
  };

  Object.defineProperty(w, '__figmaRemote', {
    value: Object.freeze({
      ready: () => ready,
      /** @param {string} toolName @param {unknown} args @param {unknown} clientInfo */
      query: (toolName, args, clientInfo) => send('sendMCPQuery', { toolName, args, clientInfo }),
      /** The bytes behind http://localhost:3845/assets/<filename>, base64 @param {string} filename */
      image: async (filename) => base64(/** @type {Uint8Array} */ (await send('sendMCPImageQuery', { filename }))),
      /** Whether every change has reached Figma's servers */
      saved: () => saved,
      /** Figma installs the plugin API on window.figma once a file it lets you run plugins in has loaded. */
      pluginsAllowed: () => typeof w.figma === 'object' && w.figma !== null,
      /** What Figma says about the open file: loaded, and whether this account may edit it and run plugins in it */
      fileState() {
        const st = store().getState();
        return { loaded: !!st.mirror?.appModel?.isInitialized, canEdit: st.openFile?.canEdit, canRunExtensions: st.openFile?.canRunExtensions };
      },
      /** Whether the plugin's main thread is running and listening */
      pluginRunning: () => !!toMain,
      /** Runs local plugin `id` the way Plugins › Development › <name> does. @param {number} id */
      runPlugin(id) {
        const s = store();
        const plugin = s.getState().localPlugins?.[id];
        if (!plugin) throw new Error(`Local plugin ${id} is not loaded yet.`);
        if (plugin.error) throw new Error(`Local plugin ${id}: ${plugin.error.text}`);
        hookUi();
        const manager = findExport('Cannot enqueue a plugin that contains a widget', (e) =>
          Object.values(e).find((v) => /** @type {any} */ (v)?.instance?.enqueue),
        );
        manager.instance.enqueue({
          mode: 'run-forever',
          runPluginArgs: { plugin, command: '', queryMode: false, runMode: 'default', triggeredFrom: 'quick-actions', openFileKey: s.getState().openFile?.key || '', isWidget: false },
        });
      },
      /** One request to the plugin's main thread; its answer. @param {{ type: string, nodeIds: string[], params: object }} request */
      request(request) {
        if (!toMain) return Promise.reject(new Error('The plugin is not running.'));
        const requestId = `fr-${++seq}`;
        return new Promise((resolve) => {
          replies.set(requestId, (m) => {
            replies.delete(requestId);
            resolve(m);
          });
          /** @type {any} */ (toMain)({ data: { pluginMessage: { type: 'server-request', payload: { ...request, requestId } }, pluginId: '*' }, origin: 'null' });
        });
      },
    }),
  });
}
