// seed.js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:admin@localhost:5432/cachelab' });

(async () => {
  const N = +process.argv[2] || 20000;

  const { rows } = await pool.query('SELECT COUNT(*) FROM logs');
  if (+rows[0].count > 0) {
    console.log(`Already seeded (${rows[0].count} rows). TRUNCATE first to reseed.`);
    await pool.end();
    return;
  }

  const values = [];
  for (let i = 1; i <= N; i++) {
    values.push(`('log message ${i}', '${i % 5 === 0 ? 'done' : 'pending'}')`);
  }

  // batch insert in chunks of 1000
  for (let i = 0; i < values.length; i += 1000) {
    const chunk = values.slice(i, i + 1000);
    await pool.query(`INSERT INTO logs (message, status) VALUES ${chunk.join(',')}`);
  }

  console.log(`Seeded ${N} logs`);
  await pool.end();
})();