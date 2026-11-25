#!/usr/bin/env node
import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DESKTOP_MCP_URL } from './figma.js';
import { defaultProfile, login, openProfile, whoAmI } from './login.js';
import { VERSION } from './mcp.js';

const HELP = `figma-remote-mcp ${VERSION}: Figma's MCP without the desktop app and without seat or rate limits
(71 tools through Figma's Plugin API, run by figma.com's editor headless).

Usage: figma-remote-mcp <command> [options]

  mcp      (default) MCP server over stdio, on the Figma session \`login\` saved.
  login    Sign in to Figma once, in a browser window.
  logout   Delete the saved session.
  doctor   Check the browser, the sign-in and Figma's tools.
  serve    Hosted MCP server over HTTP with OAuth (needs SEAL_KEY; see README).
  grant    Approve a hosted server's sign-in: opens Figma's approval page and copies
           the figma://app_auth link it hands to the desktop app.

Options:
  --profile <dir>   Browser profile for the session (default ~/.figma-remote-mcp/profile)
  --file <key|url>  doctor: also run get_metadata on this file
  --headful         Show the browser (debugging)
  --dev-mode        Also list Figma's own Dev Mode MCP tools (dev_mode_*: need a Dev or Full seat;
                    Figma's MCP rate limits apply). serve: FIGMA_DEV_MODE_TOOLS=1
  --port <n>        serve: port (default $PORT or 8080)
`;

/** @param {string} level */
const logger = (level) => {
  const order = ['debug', 'info', 'warn', 'error', 'silent'];
  const at = order.indexOf(process.env.FIGMA_REMOTE_LOG ?? level);
  const make = (/** @type {string} */ l) => (order.indexOf(l) >= at ? (/** @type {string} */ s) => process.stderr.write(`${new Date().toISOString()} ${s}\n`) : () => {});
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
};

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'mcp';
  const { values, positionals } = parseArgs({
    args: argv[0] === command ? argv.slice(1) : argv,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      file: { type: 'string' },
      headful: { type: 'boolean', default: false },
      'dev-mode': { type: 'boolean', default: false },
      port: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  });
  if (values.help || command === 'help') return void process.stdout.write(HELP);
  if (values.version) return void process.stdout.write(`${VERSION}\n`);
  const profile = values.profile ?? defaultProfile();

  switch (command) {
    case 'mcp': {
      const { startStdio } = await import('./stdio.js');
      await startStdio({ profile, headful: values.headful, devMode: values['dev-mode'], log: logger('warn') });
      return;
    }
    case 'serve': {
      const { startServer } = await import('./server.js');
      await startServer({ port: Number(values.port ?? process.env.PORT ?? 8080), log: logger('info') });
      return;
    }
    case 'login':
      return login({ profile });
    case 'logout':
      rmSync(profile, { recursive: true, force: true });
      process.stderr.write(`Removed ${profile} (signed out on this machine).\n`);
      return;
    case 'grant': {
      const { grant } = await import('./grant.js');
      return grant({ profile, url: positionals[0] });
    }
    case 'doctor':
      return doctor({ profile, file: values.file, headful: values.headful });
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

/** @param {{ profile: string, file?: string, headful: boolean }} o */
async function doctor({ profile, file, headful }) {
  const out = (/** @type {string} */ s) => process.stdout.write(`${s}\n`);
  out(`figma-remote-mcp ${VERSION}, node ${process.version}, ${process.platform}/${process.arch}`);
  const desktop = await fetch(DESKTOP_MCP_URL, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  out(`desktop app    ${desktop ? '• running (not needed)' : '• not running (not needed)'}`);
  let context;
  try {
    context = await openProfile(profile, { headless: !headful });
    out('browser        ✓ launched');
  } catch (err) {
    out(`browser        ✗ ${err instanceof Error ? err.message : err}`);
    out('Fix: install Google Chrome, or run `npx playwright install chromium`.');
    process.exitCode = 1;
    return;
  }
  const { status } = await whoAmI(context);
  if (status !== 200) {
    out(`sign-in        ✗ not signed in (/api/session/check → ${status ?? 'no answer'}). Run: figma-remote-mcp login`);
    process.exitCode = 1;
    return void (await context.close());
  }
  out('sign-in        ✓ signed in');
  const { pluginTools } = await import('./plugin-tools.js');
  out(`tools          ✓ ${pluginTools().length} plugin tools (Figma Plugin API)`);
  if (!file) {
    out('               Pass --file <key|url> to run get_metadata on a file.');
    return void (await context.close());
  }
  const { createEngine } = await import('./engine.js');
  const engine = await createEngine({ context, putAsset: (n) => `(asset ${n})`, log: logger('warn') });
  try {
    const started = Date.now();
    const r = await engine.plugin('get_metadata', { fileKey: file });
    const text = r.content.find((c) => c.type === 'text')?.text ?? '';
    out(`get_metadata   ${r.isError ? '✗' : '✓'} ${text.slice(0, 160).replace(/\s+/g, ' ')} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    if (r.isError) process.exitCode = 1;
  } catch (err) {
    out(`get_metadata   ✗ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await engine.close();
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
