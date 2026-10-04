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

    await client.query('COMMIT');

    // evict AFTER commit, then once more to clear any stale re-cache
    await redis.del(`log:${id}`);
    setTimeout(() => redis.del(`log:${id}`).catch(() => {}), 500);

    res.json(result.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
}

module.exports = updateLogStatus;