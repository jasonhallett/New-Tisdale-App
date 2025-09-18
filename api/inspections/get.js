// /api/inspections/get.js
// Fetch one Schedule 4 record (to decide if we hide the "Add to Fleetio" button).

export const config = { runtime: 'nodejs' };

const TABLE = process.env.INSPECTIONS_TABLE || 'schedule4_inspections';

async function getPool() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return pool;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow','GET'); return res.status(405).json({ error: 'Method not allowed' }); }
  try {
    const id = req.query?.id || new URL(req.url, `http://${req.headers.host}`).searchParams.get('id');
    if (!id) return res.status(400).json({ error: 'id is required' });

    const pool = await getPool();
    const { rows } = await pool.query(
      `SELECT inspection_id, internal_work_order_number, fleetio_work_order_id FROM ${TABLE} WHERE inspection_id = $1`,
      [id]
    );
    res.status(200).json({ ok: true, record: rows[0] || null });
  } catch (err) {
    console.error('inspections/get error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
