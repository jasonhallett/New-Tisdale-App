import { sql } from './db.js';

export default async function handler(req, res) {
  try {
    const { rows } = await sql`SELECT NOW() as current_time`;
    return res.status(200).json({
      ok: true,
      message: 'Database connection successful ✅',
      time: rows[0].current_time
    });
  } catch (err) {
    console.error('DB Test error:', err);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Unknown error'
    });
  }
}
