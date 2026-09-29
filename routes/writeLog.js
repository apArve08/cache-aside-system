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