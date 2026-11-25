// The hosted engine pool: eviction never cuts a running call short; a sign-out retry stays in the account's queue.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPool } from '../src/pool.js';

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Fake engines that record opens and closes */
function fakes() {
  const events = /** @type {string[]} */ ([]);
  let n = 0;
  const openEngine = async (/** @type {any[]} */ cookies) => {
    const name = `${cookies[0]?.value ?? '?'}#${++n}`;
    events.push(`open ${name}`);
    return /** @type {any} */ ({ name, close: async () => void events.push(`close ${name}`) });
  };
  return { events, openEngine };
}
const cookie = (/** @type {string} */ value) => [{ name: 'c', value, domain: 'www.figma.com' }];
const tick = () => new Promise((r) => setTimeout(r, 5));

test('evicting the least recently used account waits for its running call', async () => {
  const { events, openEngine } = fakes();
  const pool = createPool({ log: quiet, putAsset: () => '', maxAccounts: 1, openEngine });
  /** @type {() => void} */
  let finish = () => {};
  const running = pool.run('a', cookie('a'), (e) => new Promise((r) => (finish = () => r(/** @type {any} */ (e).name))));
  await tick();
  const other = pool.run('b', cookie('b'), async (e) => /** @type {any} */ (e).name); // evicts a
  assert.equal(await other, 'b#2');
  await tick();
  assert.ok(!events.includes('close a#1'), 'a is not closed while its call runs');
  finish();
  assert.equal(await running, 'a#1');
  await tick();
  assert.ok(events.includes('close a#1'), 'then it is');
  await pool.close();
});

test("a sign-out restarts the account's engine in place and retries once, in order with the account's calls", async () => {
  const { events, openEngine } = fakes();
  const pool = createPool({ log: quiet, putAsset: () => '', openEngine });
  const order = /** @type {string[]} */ ([]);
  let first = true;
  const signedOut = pool.run('a', cookie('a'), async (e) => {
    order.push(`call1 on ${/** @type {any} */ (e).name}`);
    if (first) {
      first = false;
      await tick();
      throw Object.assign(new Error('ended'), { code: 'auth' });
    }
    return 'retried';
  });
  const next = pool.run('a', cookie('a'), async (e) => void order.push(`call2 on ${/** @type {any} */ (e).name}`));
  assert.equal(await signedOut, 'retried');
  await next;
  assert.deepEqual(order, ['call1 on a#1', 'call1 on a#2', 'call2 on a#2']);
  await tick();
  assert.ok(events.includes('close a#1'));
  await pool.close();
});
