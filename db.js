// db.js
const { Pool } = require('pg');
const { createClient } = require('redis');

const pg = new Pool({ connectionString: 'postgresql://postgres:admin@localhost:5432/cachelab' });

const redis = createClient({ url: 'redis://localhost:6379' });
redis.connect();

module.exports = { pg, redis };