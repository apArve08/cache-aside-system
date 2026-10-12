// test/cache.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { createClient } = require('redis');

const BASE = 'http://localhost:3000';
const pg = new Pool({ connectionString: 'postgresql://postgres:admin@localhost:5432/cachelab' });
const redis = createClient({ url: 'redis://localhost:6379' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let id;

const get = async (id) => {
  const res = await fetch(`${BASE}/logs/${id}`);
  return { cache: res.headers.get('x-cache'), body: await res.json() };
};

const patch = (id, status) =>
  fetch(`${BASE}/logs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });

before(async () => {
  await redis.connect();
  const probe = await fetch(`${BASE}/logs/1`);
  assert.notEqual(probe.headers.get('x-cache'), 'BYPASS', 'Start the server with caching ON');
  const r = await pg.query(
    "INSERT INTO logs (message, status) VALUES ('test row', 'v0') RETURNING id"
  );
  id = r.rows[0].id;
});

after(async () => {
  await pg.query('DELETE FROM logs WHERE id = $1', [id]);
  await redis.del(`log:${id}`);
  await redis.quit();
  await pg.end();
});

test('1. create -> cache -> update -> fresh read', async () => {
  let r = await get(id);
  assert.equal(r.cache, 'MISS', 'first read should miss');
  assert.equal(r.body.status, 'v0');

  r = await get(id);
  assert.equal(r.cache, 'HIT', 'second read should hit');

  const p = await patch(id, 'v1');
  assert.equal(p.status, 200);
  assert.equal(await redis.exists(`log:${id}`), 0, 'PATCH should evict the cache key');

  await sleep(700); // let the delayed second DEL (500 ms) finish
  r = await get(id);
  assert.equal(r.cache, 'MISS', 'read after update should miss');
  assert.equal(r.body.status, 'v1', 'read after update should see the new value');

  r = await get(id);
  assert.equal(r.cache, 'HIT');
  assert.equal(r.body.status, 'v1', 'cache should hold the new value');
});

test('2. no stale cache after concurrent reads during writes', async () => {
  for (let i = 2; i < 22; i++) {
    const status = `v${i}`;

    // 1 write + 20 reads at the same moment
    const readers = Array.from({ length: 20 }, () => get(id));
    await Promise.all([patch(id, status), ...readers]);

    await sleep(700); // let the delayed DEL finish

    const { rows } = await pg.query('SELECT status FROM logs WHERE id = $1', [id]);
    assert.equal(rows[0].status, status, `Postgres wrong at iteration ${i}`);

    const cached = await redis.get(`log:${id}`);
    if (cached) {
      assert.equal(JSON.parse(cached).status, status, `stale cache at iteration ${i}`);
    }

    const r = await get(id);
    assert.equal(r.body.status, status, `stale read at iteration ${i}`);
  }
});

test('3. PATCH on a missing row returns 404', async () => {
  const p = await patch(99999999, 'x');
  assert.equal(p.status, 404);
});