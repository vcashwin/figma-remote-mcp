// Figma's image assets for results (Figma Desktop serves them at http://localhost:3845/assets/<name>, from the page's
// memory): kept in this process's memory behind unguessable URLs, for an hour, within a byte budget.
import { randomBytes } from 'node:crypto';

/**
 * @param {{ baseUrl: () => string, ttlMs?: number, maxBytes?: number }} options  baseUrl: the origin assets are served on
 */
export function createAssetStore({ baseUrl, ttlMs = 3_600_000, maxBytes = 256 * 1024 * 1024 }) {
  /** Insertion order is age order. @type {Map<string, { body: Buffer, mime: string, expires: number }>} */
  const assets = new Map();
  let bytes = 0;

  const drop = (/** @type {string} */ id) => {
    const a = assets.get(id);
    if (a) bytes -= a.body.length;
    assets.delete(id);
  };
  const prune = () => {
    for (const [id, a] of assets) {
      // the newest stays even past the budget: its link was just handed out
      if ((a.expires > Date.now() && bytes <= maxBytes) || assets.size === 1) break;
      drop(id);
    }
  };

  return {
    /** Stores an asset; its URL. @param {string} name @param {string} base64 @param {string} mime */
    put(name, base64, mime) {
      const id = `${randomBytes(18).toString('base64url')}/${encodeURIComponent(name)}`;
      const body = Buffer.from(base64, 'base64');
      assets.set(id, { body, mime, expires: Date.now() + ttlMs });
      bytes += body.length;
      prune();
      return `${baseUrl()}/assets/${id}`;
    },
    /** The asset at a `/assets/<id>/<name>` path, if it is still kept @param {string} path */
    get(path) {
      const id = path.replace(/^\/assets\//, '');
      const a = assets.get(id);
      if (!a) return undefined;
      if (a.expires <= Date.now()) return void drop(id);
      return a;
    },
  };
}

/**
 * Answers GET /assets/… from the store; undefined for any other path.
 * @param {ReturnType<typeof createAssetStore>} store @param {string} method @param {string} path
 */
export function assetResponse(store, method, path) {
  if (!path.startsWith('/assets/')) return undefined;
  const a = method === 'GET' || method === 'HEAD' ? store.get(path) : undefined;
  if (!a) return new Response('Not found (asset links expire after an hour)', { status: 404 });
  return new Response(method === 'HEAD' ? null : new Uint8Array(a.body), {
    headers: {
      'content-type': a.mime,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      // an SVG asset opened directly must not run script
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  });
}
