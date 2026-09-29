// server.js
const express = require('express');
const cacheAside = require('./middleware/cacheAside');
const { pg, redis } = require('./db');
const updateLogStatus = require('./routes/writeLog');

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

// server.js — add this route
const updateLogStatus = require('./routes/writeLog');
app.patch('/logs/:id', express.json(), updateLogStatus);
app.listen(3000, () => console.log('Listening on :3000'));