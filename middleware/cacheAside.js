// middleware/cacheAside.js
const { redis, pg } = require('../db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cacheAside({ keyFn, queryFn, ttl = 300 }) {
  return async (req, res, next) => {
    // Control group: bypass Redis completely
    if (process.env.CACHE_ENABLED === 'false') {
      try {
        res.set('X-Cache', 'BYPASS');
        return res.json(await queryFn(req, pg));
      } catch (err) {
        return next(err);
      }
    }

    const key = keyFn(req);

    // 1. Normal cache check
    try {
      const cached = await redis.get(key);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      console.error('Redis read error:', err.message);
    }

    // 2. Miss: try to become the single request that rebuilds the cache
    const lockKey = `lock:${key}`;
    let gotLock = false;
    try {
      gotLock = !!(await redis.set(lockKey, '1', { NX: true, EX: 10 }));
    } catch (err) {
      console.error('Redis lock error:', err.message);
    }

    if (gotLock) {
      try {
        if (process.env.DEBUG_DB === '1') console.log('DB QUERY', key);
        const result = await queryFn(req, pg);
        await redis.set(key, JSON.stringify(result), { EX: ttl }); // await: fill cache BEFORE releasing lock
        res.set('X-Cache', 'MISS');
        return res.json(result);
      } catch (err) {
        return next(err);
      } finally {
        await redis.del(lockKey).catch(() => {});
      }
    }

    // 3. Someone else holds the lock: wait briefly for their result
    for (let i = 0; i < 10; i++) {
      await sleep(50);
      try {
        const cached = await redis.get(key);
        if (cached) {
          res.set('X-Cache', 'HIT-WAIT');
          return res.json(JSON.parse(cached));
        }
      } catch (err) { break; }
    }

    // 4. Still nothing after ~500ms: read Postgres directly (don't cache)
    try {
      if (process.env.DEBUG_DB === '1') console.log('DB QUERY (fallback)', key);
      res.set('X-Cache', 'MISS-FALLBACK');
      return res.json(await queryFn(req, pg));
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = cacheAside;