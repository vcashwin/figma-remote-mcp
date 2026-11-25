# How Figma Desktop's MCP server works, and how this replaces it

Reverse-engineered from Figma Desktop 126.11.11 (Electron; `app.asar`) and the figma.com web client of the same week
(November 2026), then checked against the live desktop server and a live, signed-in headless editor.

## The desktop server is a pipe

`lazy/external/codegen_mcp_server.js` in `app.asar` is a stock `@modelcontextprotocol/sdk` server, named "Figma Dev Mode MCP
Server", with no Figma logic in it:

- It listens on `127.0.0.1:3845`: Streamable HTTP at `/mcp`, legacy SSE at `/sse` + `/messages`, and images at
  `/assets/<name>`.
- A Host-header check (localhost or an IP literal) guards against DNS rebinding. There is no Origin check and no auth.
- It starts only when the figma.com page asks for it (`setEnableMCP(true, 3845)`, the port hard-coded in the web
  app). The page asks when the user preference "Enable Dev Mode MCP server" is on.
- It has no `instructions`. The long instructions and `skill://` resources belong to Figma's hosted server,
  `mcp.figma.com`.

Every MCP method becomes one message to the **active tab of the last-focused window**:

| MCP | message to the page (`sendMCPQuery {queryId, toolName, args, clientInfo, requestInfo, sessionId}`) |
| --- | --- |
| `tools/list` | `toolName: "internal_get_tools"` |
| `tools/call` | `toolName: <name>`, `args: <arguments>` |
| `resources/list`, `resources/templates/list` | `"internal_get_resources_list"`, `{isTemplates}` |
| `resources/read` | `"internal_get_resource"`, `{uri}` |
| `prompts/list`, `prompts/get` | `"internal_get_prompts_list"`, `"internal_get_prompt"` `{promptName, args}` |
| `GET /assets/<name>` | `sendMCPImageQuery {queryId, filename}` |

The page replies with `sendMCPResult` / `sendMCPImageResult`, as `{queryId, result: {result}}` or
`{queryId, result: {error, errorObj}}`. Routing is by focus only: the tools have no file argument, and `nodeId` defaults
to the tab's selection.

## The bridge

Figma Desktop's preload (`web_app_binding_renderer.js`) installs `window.__figmaDesktop` in the figma.com page:
`{version, backportedApiFeatures, appVersion, …, postMessage(name, args), promiseMessage(name, args) → Promise,
registerCallback(name, args, cb), setMessageHandler(fn)}`.

On the figma.com side:

- The bundle checks `!!window.__figmaDesktop` once, as it loads, then keeps its own reference and deletes the global.
- At app boot it calls `setMessageHandler(fn)` and posts `messageHandlerRegistered`. Main-process messages reach the page
  as `fn(name, args)`.
- The MCP tool runner sits behind `fn("sendMCPQuery", …)`. Every tool runs on the page: design-to-code (React + Tailwind)
  on the editor's WASM scene graph, PNG export, the XML node tree, variables, the motion export.

`src/shim.js` installs a stand-in for that object before any page script runs:

- It keeps the handler, sends it queries and resolves them from the page's `sendMCPResult` posts.
- It answers the handful of promise calls the page makes at startup the way a desktop with no local fonts would:
  `getFonts → {}`, `setEnableMCP → already running`, …
- Every other promise call is rejected (`"No result"`), which is what the real preload does for a name it lacks.

## Development plugins without the desktop (the tools)

Figma Desktop serves local ("development") plugins to the figma.com page through the same bridge. The page asks for them
on editor load:

| Message | Answer |
| --- | --- |
| `getLocalManifestFileExtensionIdsToCachedMetadataMap()` | `{[id]: {lastKnownPluginId, cachedContainsWidget}}`. Ids are small integers from 1. |
| `getLocalFileExtensionManifest({id})` | `{path, lastKnownName, lastKnownPluginId, manifest: <raw JSON>, cachedContainsWidget}` |
| `getLocalFileExtensionSource({id})` | `{stdout, stderr, path, source: <main code>, html?: <ui>}` |

Plugins › Development › <name> enqueues the plugin with the page's `PluginManager.instance.enqueue({mode: "run-forever",
runPluginArgs: {plugin: localPlugins[id], …}})`. The stand-in serves the tools plugin as plugin 1 and makes the same call
once the page allows plugins in the file.

- **When plugins are allowed:** figma.com installs `window.figma` once the document has loaded in a file this account
  can edit and run plugins in.
- **Finding the plugin manager:** the stand-in finds it through the page's own module loader (the rspack JSONP runtime),
  by a string in the module's source, not by module id, because ids change every release.
- **Messages:** the plugin UI host's `createInnerIframe` receives the handler that feeds `figma.ui.onmessage`, and
  returns the frame that `figma.ui.postMessage` messages go to. The stand-in hooks both, so requests and answers pass
  between Node and the plugin's main thread with no WebSocket. The plugin's UI is a stub.
- **No usage reporting:** development plugin runs are recorded only in the page's localStorage ("recently used"), not
  reported as usage.

Saving: the page tells the shell whether everything is saved (`setSaved`). The engine waits for it before freezing an
idle page (frozen pages cost a fraction of the CPU of a live editor) or closing one.

## What the page checks (all left as they are)

- **Shell detection:** the `__figmaDesktop` object exists before the bundle loads, and the app version is not past
  Figma's support cutoff for 126.11.x.
- **File state:** a design, FigJam or Make file is open (FigJam allows a subset of the Dev Mode tools).
- **Plugins:** the account can edit the file and run plugins in it. In view-only files there is no `window.figma`, and
  Figma refuses design-mode plugins.
- **The user's preference:** if it is off, tools answer "The MCP server is not enabled for this user". Turn on Dev Mode's
  MCP server in Figma's preferences once.
- **Entitlements:**
  - Figma checks the seat for the file ("paid Figma seat includes Dev Mode access …") and the org admin's "MCP disabled"
    switch.
  - Calls are rate-limited through `POST /api/mcp/rate_limit` ("Rate limit exceeded, please try again tomorrow").
  - Code Connect tools are listed only with Code Connect access.

None of these are bypassed: figma-remote-mcp gives the same answers the desktop app gives.

## Signing in without the desktop

Figma Desktop's own sign-in never sees a password:

1. `POST /api/session/app_auth {"app_type":"desktop"}` → `{meta: {id}}`. Figma also sets an anonymous `figma.session`
   cookie, which the redemption needs.
2. The person opens `https://www.figma.com/app_auth/<id>/grant?desktop_protocol=figma` in their own signed-in browser,
   picks an account and clicks **Open the desktop app**. The page calls `POST /api/session/app_auth/<id>/grant` and
   redirects to `figma://app_auth/redeem?g_secret=<secret>`.
3. `POST /api/session/app_auth/redeem {"g_secret"}`, sent with the cookies from step 1, sets the web session cookies
   (`__Host-figma.authn`, …) and returns `{meta: {workspace: {userId, …}}}`.

There is no polling endpoint. Figma ignores any `desktop_protocol` other than its own, and browsers don't show custom
scheme links. So the hosted server asks for the link to be pasted, and `figma-remote-mcp grant` catches it in a browser
window it controls. `GET /api/session/check` (200 or 401) tells whether a session is still signed in.

## Running the editor headless

- Figma's CDN (CloudFront) answers `403 Request blocked` to the `HeadlessChrome` user agent, so pages present a desktop
  Chrome one.
- `--use-angle=swiftshader --enable-unsafe-swiftshader` gives the editor WebGL without a GPU.
- **Timing:**
  - Opening a file takes about 5–7 s (scene graph load and WASM compile) before Figma's desktop handler answers.
  - Plugins are allowed only once the whole document has loaded: from a few seconds for a small file to about 25 s
    for an 88-page design system.
  - After that, a query takes milliseconds.
- figma.com's immutable assets (JS, WASM, fonts; about 130 MB) are served from a disk cache shared by every account's
  context.
- The file browser (`/files`) never registers the desktop handler; only an open file does. Before any call names a
  file, the catalog comes from the account's most recent file, and the hosted server shares it across accounts for an hour.
