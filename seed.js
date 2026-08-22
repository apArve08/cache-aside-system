// seed.js
const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://admin:admin@localhost:5432/cachelab' });

(async () => {
  const values = [];
  for (let i = 1; i <= 50000; i++) {
    values.push(`('log message ${i}', '${i % 5 === 0 ? 'done' : 'pending'}')`);
  }
  // batch insert in chunks of 1000
  for (let i = 0; i < values.length; i += 1000) {
    const chunk = values.slice(i, i + 1000);
    await pool.query(`INSERT INTO logs (message, status) VALUES ${chunk.join(',')}`);
  }
  console.log('Seeded 50,000 logs');
  await pool.end();
})();