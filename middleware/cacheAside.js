// middleware/cacheAside.js
const { redis, pg } = require('../db');

function cacheAside({ keyFn, queryFn, ttl = 300 }) {
  return async (req, res, next) => {
    const key = keyFn(req);

    try {
      const cached = await redis.get(key);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(JSON.parse(cached));
      }
    } catch (err) {
      // Redis down — don't crash the request, just fall through to Postgres
      console.error('Redis read error:', err.message);
    }

    // MISS path
    try {
      const result = await queryFn(req, pg);
      res.set('X-Cache', 'MISS');

      // populate cache, but don't block the response on it
      redis.set(key, JSON.stringify(result), { EX: ttl }).catch(e =>
        console.error('Redis write error:', e.message)
      );

      return res.json(result);
    } catch (err) {
      next(err);
    }
  };
}

module.exports = cacheAside;