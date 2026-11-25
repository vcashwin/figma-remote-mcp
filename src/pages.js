// The hosted server's pages: landing, consent and sign-in. Every interpolated value is escaped.

/** @param {string} value */
export const escape = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1e1e1e;--muted:#6b6b6b;--line:#e3e3e3;--card:#fafafa;--accent:#0d99ff;--bad:#e5484d}
@media (prefers-color-scheme:dark){:root{--bg:#1e1e1e;--fg:#f0f0f0;--muted:#a0a0a0;--line:#383838;--card:#262626}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,-apple-system,sans-serif}
main{max-width:520px;margin:64px auto;padding:0 20px;display:flex;flex-direction:column;gap:18px}
h1{font-size:20px;margin:0}p{margin:0}.muted{color:var(--muted)}.bad{color:var(--bad)}
.card{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}
.row{display:flex;gap:10px}.row b{min-width:110px;font-weight:500;color:var(--muted)}.wrap{overflow-wrap:anywhere}
code,.code{font:12.5px ui-monospace,Menlo,monospace;background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 10px;display:block;white-space:pre-wrap;overflow-wrap:anywhere;user-select:all}
ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:12px}
input[type=text]{font:inherit;width:100%;padding:9px 12px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg)}
.buttons{display:flex;gap:8px;justify-content:flex-end}
button,.button{font:inherit;font-weight:500;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;text-decoration:none;display:inline-block;white-space:nowrap}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}`;

/** @param {string} title @param {string} body */
const html = (title, body) =>
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;

/** @param {string} mcpUrl */
export const homePage = (mcpUrl) =>
  html(
    'Figma Remote MCP',
    `<h1>Figma Remote MCP</h1><p class="muted">Read and edit Figma designs through Figma's Plugin API, run by figma.com's editor on this server. Add it to your MCP client:</p>` +
      `<code>claude mcp add --transport http figma ${escape(mcpUrl)}</code>` +
      `<p class="muted">Your client signs you in with your Figma account on first use. The tools work on files your account can edit.</p>`,
  );

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Where a redirect URI sends the browser @param {string} uri */
function destination(uri) {
  const { host, hostname } = new URL(uri);
  return LOOPBACK.has(hostname) ? `${host} (this computer)` : host || uri;
}

/**
 * @param {{ clientName: string, redirectUri: string, clientHost?: string, state: string, csrfToken: string }} p
 */
export function consentPage({ clientName, redirectUri, clientHost, state, csrfToken }) {
  const name = escape(clientName);
  return html(
    `${clientName} | Authorization request`,
    `<form method="post" action="/authorize" style="display:contents"><input type="hidden" name="state" value="${escape(state)}"><input type="hidden" name="csrf_token" value="${escape(csrfToken)}">` +
      `<h1><strong>${name}</strong> wants to use your Figma account</h1>` +
      (clientHost
        ? `<p class="muted">Client published by <strong>${escape(clientHost)}</strong></p>`
        : `<p class="bad" role="alert">Unverified app: only continue if you started this from <strong>${name}</strong>.</p>`) +
      `<div class="card"><div class="row"><b>Client</b><span>${name}</span></div>` +
      `<div class="row"><b>Returns you to</b><span class="wrap">${escape(destination(redirectUri))}</span></div>` +
      `<div class="row"><b>Access</b><span>Read and edit the Figma files you can edit, through Figma's Plugin API</span></div></div>` +
      `<p class="muted">Continuing takes you to Figma's own approval page, the one Figma Desktop's sign-in uses. Your password never reaches this server. ${name} then works in your files as you, as a collaborator would.</p>` +
      `<div class="buttons"><button name="action" value="deny">Cancel</button><button class="primary" name="action" value="approve">Continue</button></div></form>`,
  );
}

/**
 * The sign-in step: approve on Figma's page, then paste the figma:// link Figma hands to the desktop app.
 * @param {{ flow: string, grantUrl: string, message?: string }} p
 */
export function signInPage({ flow, grantUrl, message }) {
  const url = escape(grantUrl);
  return html(
    'Sign in with Figma',
    `<h1>Sign in with Figma</h1>` +
      (message ? `<p class="bad" role="alert">${escape(message)}</p>` : '') +
      `<ol><li><a class="button primary" href="${url}" target="_blank" rel="noopener noreferrer">Open Figma's approval page</a><br><span class="muted">Pick your account and click <strong>Open the desktop app</strong>.</span></li>` +
      `<li>Figma then hands a <code style="display:inline;padding:1px 4px">figma://app_auth/redeem?g_secret=…</code> link to the desktop app. Paste that link here. Browsers don't show it, so the easy way is to run this instead of step 1: it opens the same page and copies the link when you click the button.` +
      `<code>npx figma-remote-mcp grant "${url}"</code></li>` +
      `<li><form method="post" action="/signin" style="display:flex;gap:8px"><input type="hidden" name="flow" value="${escape(flow)}"><input type="text" name="link" placeholder="figma://app_auth/redeem?g_secret=…" autocomplete="off" required autofocus><button class="primary">Sign in</button></form></li></ol>` +
      `<p class="muted">The link is a one-time secret for this sign-in only. If Figma Desktop is installed, it may open and use the link itself; then start again with the command above.</p>`,
  );
}
