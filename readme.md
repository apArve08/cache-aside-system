Distributed Cache-Aside System — Full Build Walkthrough
Prerequisites
bash
mkdir cache-aside-system && cd cache-aside-system
npm init -y
npm install express pg redis dotenv
npm install -D nodemon
WEEK 05 — Two-Tier Database Setup
Step 1: Docker Compose for Postgres + Redis
yaml
# docker-compose.yml
version: '3.8'
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: admin
      POSTGRES_PASSWORD: admin
      POSTGRES_DB: cachelab
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru

volumes:
  pgdata:
bash
docker compose up -d

The maxmemory-policy allkeys-lru matters: it tells Redis to evict the least recently used keys when memory fills up, instead of crashing or refusing writes. This is realistic — production caches don't have infinite RAM.

Step 2: Create the schema and seed data
sql
-- init.sql
CREATE TABLE logs (
  id SERIAL PRIMARY KEY,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
);
bash
docker exec -i $(docker compose ps -q postgres) psql -U admin -d cachelab < init.sql
Step 3: Seed script
js
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
bash
node seed.js
Step 4: Verify both connections work
js
// db-check.js
const { Pool } = require('pg');
const { createClient } = require('redis');

(async () => {
  const pg = new Pool({ connectionString: 'postgresql://admin:admin@localhost:5432/cachelab' });
  const r = await pg.query('SELECT COUNT(*) FROM logs');
  console.log('Postgres rows:', r.rows[0].count);

  const redis = createClient({ url: 'redis://localhost:6379' });
  await redis.connect();
  await redis.set('healthcheck', 'ok');
  console.log('Redis:', await redis.get('healthcheck'));
  await redis.quit();
  await pg.end();
})();

Checkpoint: Both containers up, 50,000 rows in Postgres, Redis responding to GET/SET.

WEEK 06 — Cache-Aside Middleware
Step 1: Shared connection module
js
// db.js
const { Pool } = require('pg');
const { createClient } = require('redis');

const pg = new Pool({ connectionString: 'postgresql://admin:admin@localhost:5432/cachelab' });

const redis = createClient({ url: 'redis://localhost:6379' });
redis.connect();

module.exports = { pg, redis };
Step 2: The cache-aside middleware factory

This is the heart of the project. It's a higher-order function: you give it a function that builds a cache key from the request, and it returns middleware.

js
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

Key design choices to understand:

X-Cache header — lets you verify hit/miss behavior with curl -i without instrumenting the client.
Redis errors don't fail the request — if Redis is down, you degrade to "every request hits Postgres" rather than 500ing. This is the whole point of cache-aside vs. cache-as-source-of-truth.
Fire-and-forget cache population — the client gets their response immediately; the cache write happens in the background.
Step 3: Wire it into routes
js
// server.js
const express = require('express');
const cacheAside = require('./middleware/cacheAside');
const { pg, redis } = require('./db');

const app = express();
app.use(express.json());

app.get('/logs/:id',
  cacheAside({
    keyFn: (req) => `log:${req.params.id}`,
    queryFn: async (req, db) => {
      const r = await db.query('SELECT * FROM logs WHERE id = $1', [req.params.id]);
      return r.rows[0] || null;
    },
    ttl: 300
  }),
  (req, res) => res.end() // unreachable if cacheAside responds, but Express needs a handler
);

app.get('/logs', 
  cacheAside({
    keyFn: (req) => `logs:page:${req.query.page || 1}`,
    queryFn: async (req, db) => {
      const page = parseInt(req.query.page) || 1;
      const offset = (page - 1) * 50;
      const r = await db.query('SELECT * FROM logs ORDER BY id LIMIT 50 OFFSET $1', [offset]);
      return r.rows;
    },
    ttl: 60
  }),
  (req, res) => res.end()
);

app.listen(3000, () => console.log('Listening on :3000'));
Step 4: Test hit/miss behavior
bash
curl -i http://localhost:3000/logs/42
# X-Cache: MISS  (first call, hits Postgres)

curl -i http://localhost:3000/logs/42
# X-Cache: HIT   (second call, served from Redis)

Check it directly in Redis:

bash
docker exec -it $(docker compose ps -q redis) redis-cli GET "log:42"
docker exec -it $(docker compose ps -q redis) redis-cli TTL "log:42"

Checkpoint: First request is a MISS and populates Redis; repeat requests within 300s are HITs and never touch Postgres. Confirm by stopping the Postgres container temporarily — HIT requests should still succeed.

WEEK 07 — Atomic Cache Invalidation
Step 1: Understand the failure mode first

Re-read the stepper above. The core risk: UPDATE commits to Postgres, then the process dies before redis.del() runs → stale data served until TTL expiry.

Step 2: Write path with transaction wrapping
js
// routes/writeLog.js
const { pg, redis } = require('../db');

async function updateLogStatus(req, res, next) {
  const { id } = req.params;
  const { status } = req.body;
  const client = await pg.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      'UPDATE logs SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );

    if (result.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'not found' });
    }

    // delete cache key WHILE inside the still-uncommitted transaction
    await redis.del(`log:${id}`);

    await client.query('COMMIT');
    res.json(result.rows[0]);

  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

module.exports = updateLogStatus;
js
// server.js — add this route
const updateLogStatus = require('./routes/writeLog');
app.patch('/logs/:id', express.json(), updateLogStatus);

Critical nuance: Postgres COMMIT and Redis DEL are not in one atomic transaction across systems — that's impossible (different databases, no distributed transaction coordinator here). What you've actually built is: order the operations so that if a crash happens, the worst case is a harmless cache miss, never stale data.

Walk through both crash points:

Crash before redis.del() → Postgres transaction never commits → ROLLBACK on reconnect → Postgres still has old value, Redis still has old value. Consistent (both stale-but-matching).
Crash after redis.del() but before COMMIT → Postgres ROLLBACK reverts the UPDATE → Postgres has old value, Redis has no key (it was deleted) → next read is a MISS → fetches old value from Postgres → repopulates Redis with old value. Consistent.
Crash after COMMIT → both succeeded, fully consistent, done.

There's no window where Postgres has the new value and Redis has the old value — that's the bug from the "naive" scenario in the stepper.

Step 3: The remaining race condition (concurrent writes)

Even with this ordering, two concurrent requests updating the same row can interleave:

Request A: BEGIN → UPDATE → DEL redis key → ...
Request B:                                    BEGIN → UPDATE → DEL redis key → COMMIT
Request A: ... COMMIT

If a read sneaks in between A's DEL and A's COMMIT, it gets a cache MISS, queries Postgres — but Postgres still shows A's uncommitted value isn't visible yet (it sees the pre-A value, since A hasn't committed), populates Redis with the old value. Then A commits. Now Redis has stale data again, with no further write to evict it until TTL.

This is the classic cache-aside race. Two mitigations, in increasing complexity:

Mitigation 1 — short TTL as a backstop. Accept this can happen, but bound the staleness window to the TTL (e.g. 60s). Often "good enough" for read-heavy, eventually-consistent workloads.

Mitigation 2 — delete-after-commit too (double delete).

js
await client.query('COMMIT');
await redis.del(`log:${id}`); // second delete, after commit is durable
res.json(result.rows[0]);

This catches the race window: even if a stale read repopulated Redis during the transaction, the post-commit delete clears it out again.

Step 4: Test invalidation
bash
# populate cache
curl http://localhost:3000/logs/42

# update — should invalidate
curl -i -X PATCH http://localhost:3000/logs/42 \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'

# next read should be MISS with new value
curl -i http://localhost:3000/logs/42
# X-Cache: MISS, status: "done"

curl -i http://localhost:3000/logs/42
# X-Cache: HIT, status: "done"

Checkpoint: PATCH a record → next GET is a MISS and returns the updated value → subsequent GET is a HIT with the updated value.

WEEK 08 — Load Test & Performance Metrics
Step 1: Install k6
bash
# macOS
brew install k6
# or Docker
docker pull grafana/k6
Step 2: Cold-cache load test (worst case)
js
// load-cold.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 200,
  duration: '30s',
};

export default function () {
  const id = Math.floor(Math.random() * 50000) + 1; // random row, low cache hit chance
  const res = http.get(`http://localhost:3000/logs/${id}`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}
Step 3: Warm-cache load test (best case)
js
// load-warm.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: 200,
  duration: '30s',
};

export default function () {
  const id = Math.floor(Math.random() * 100) + 1; // small hot set — likely cached
  const res = http.get(`http://localhost:3000/logs/${id}`);
  check(res, { 'status 200': (r) => r.status === 200 });
  sleep(0.1);
}
Step 4: Run and capture metrics
bash
# warm the cache first for the warm test
for i in $(seq 1 100); do curl -s http://localhost:3000/logs/$i > /dev/null; done

k6 run load-cold.js
k6 run load-warm.js
Step 5: Capture CPU usage during each run

In a second terminal, while k6 runs:

bash
docker stats --no-stream $(docker compose ps -q postgres)

Or for a continuous graph, run this in the background during both load tests:

bash
while true; do
  docker stats --no-stream --format "{{.CPUPerc}}" $(docker compose ps -q postgres) >> pg-cpu.log
  sleep 1
done
Step 6: Compare results

From k6 output, record for both runs:

Metric	Cold (random IDs)	Warm (hot 100 IDs)
http_req_duration p95	~20-40ms	~1-3ms
Postgres CPU	60-90%	5-15%
Requests/sec	lower	much higher

Plot pg-cpu.log with a quick script (gnuplot, Python matplotlib, or Excel) — the visual difference between the two CPU traces is the deliverable proof that cache-aside protects the relational backend under load.

Checkpoint: Two k6 reports + a CPU graph showing Postgres load dropping dramatically when requests target cached data.

Project structure summary
cache-aside-system/
├── docker-compose.yml
├── init.sql
├── seed.js
├── db.js
├── server.js
├── middleware/
│   └── cacheAside.js
├── routes/
│   └── writeLog.js
├── load-cold.js
└── load-warm.js

That's the full build, week by week. Want me to go deeper on any single piece — e.g. the double-delete race condition fix, or setting up the CPU graphing script?