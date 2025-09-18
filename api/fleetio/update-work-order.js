// /api/inspections/update-work-order.js
// Upsert work-order info onto your Schedule 4 record so we can lock the "Add to Fleetio" button.
// Table is configurable via INSPECTIONS_TABLE (default: schedule4_inspections).

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
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  try {
    const { inspectionId, internal_work_order_number, fleetio_work_order_id } = await req.json?.() || req.body || {};
    if (!inspectionId) return res.status(400).json({ error: 'inspectionId is required' });

    const pool = await getPool();
    // Ensure columns exist (safety). You should also run the SQL migration.
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'internal_work_order_number'
        ) THEN
          EXECUTE 'ALTER TABLE ' || quote_ident($1) || ' ADD COLUMN internal_work_order_number TEXT';
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'fleetio_work_order_id'
        ) THEN
          EXECUTE 'ALTER TABLE ' || quote_ident($1) || ' ADD COLUMN fleetio_work_order_id BIGINT';
        END IF;
      END $$;
    `, [TABLE]);

    const result = await pool.query(
      `INSERT INTO ${TABLE} (inspection_id, internal_work_order_number, fleetio_work_order_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (inspection_id)
       DO UPDATE SET internal_work_order_number = COALESCE(EXCLUDED.internal_work_order_number, ${TABLE}.internal_work_order_number),
                     fleetio_work_order_id = COALESCE(EXCLUDED.fleetio_work_order_id, ${TABLE}.fleetio_work_order_id),
                     updated_at = now()
       RETURNING inspection_id, internal_work_order_number, fleetio_work_order_id`,
      [inspectionId, internal_work_order_number || null, fleetio_work_order_id || null]
    );

    res.status(200).json({ ok: true, record: result.rows[0] });
  } catch (err) {
    console.error('update-work-order error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
