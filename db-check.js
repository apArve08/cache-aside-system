// db-check.js
const { Pool } = require('pg');
const { createClient } = require('redis');

(async () => {
  const pg = new Pool({ connectionString: 'postgresql://postgres:admin@localhost:5432/cachelab' });
  const r = await pg.query('SELECT COUNT(*) FROM logs');
  console.log('Postgres rows:', r.rows[0].count);

  const redis = createClient({ url: 'redis://localhost:6379' });
  await redis.connect();
  await redis.set('healthcheck', 'ok');
  console.log('Redis:', await redis.get('healthcheck'));
  await redis.quit();
  await pg.end();
})();