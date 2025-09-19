// /api/fleetio/create-work-order.js
// Vercel serverless function
// - Creates a Fleetio Work Order (your existing logic)
// - Persists WO number/ID back to Neon (fixed to update by primary key `id`)

const PG_ENABLED = !!process.env.DATABASE_URL;

// ---------- DB helpers ----------
let _pool = null;
async function getPool() {
  if (!PG_ENABLED) return null;
  if (_pool) return _pool;
  const { Pool } = await import('pg');
  _pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  return _pool;
}

// create a deterministic SET clause from [ [col, placeholder], ... ]
function buildSet(pairs) {
  return pairs.map(([col, ph]) => `${col} = ${ph}`).join(', ');
}

/**
 * Persist Fleetio WO data back to Neon.
 * It now treats (recordId ?? inspectionId) as the primary key `id`.
 * Optional fallback to a legacy `inspection_id` column if you happen to have one.
 */
async function updateExistingInspection({ recordId, inspectionId, woId, woNumber, docName, docUrl }) {
  const pool = await getPool();
  if (!pool) return { ok: false, reason: 'no_db' };

  // SET clause, include fields only if provided
  const sets = [
    ['internal_work_order_number', '$2'],
    ['fleetio_work_order_id', '$3'],
  ];
  const params = [null, woNumber ?? null, woId ?? null];

  let p = 4;
  if (docName !== undefined) { sets.push(['fleetio_document_name', `$${p++}`]); params.push(docName ?? null); }
  if (docUrl  !== undefined) { sets.push(['fleetio_document_url',  `$${p++}`]); params.push(docUrl  ?? null); }
  sets.push(['updated_at', 'now()']);

  const setSql = buildSet(sets);

  // ✅ Primary: WHERE id = $1 using recordId OR inspectionId
  const candidateId = recordId ?? inspectionId ?? null;
  if (candidateId) {
    params[0] = candidateId;
    const sql1 = `UPDATE schedule4_inspections SET ${setSql} WHERE id = $1`;
    try {
      const r1 = await pool.query(sql1, params);
      if (r1.rowCount > 0) {
        return { ok: true, by: 'id', rowCount: r1.rowCount };
      }
    } catch (e) {
      return { ok: false, reason: 'error_id', error: String(e?.message || e) };
    }
  }

  // (Optional) Legacy fallback if you DO have an `inspection_id` column
  if (inspectionId) {
    params[0] = inspectionId;
    const sql2 = `UPDATE schedule4_inspections SET ${setSql} WHERE inspection_id = $1`;
    try {
      const r2 = await pool.query(sql2, params);
      return { ok: r2.rowCount > 0, by: r2.rowCount > 0 ? 'inspection_id' : 'none', rowCount: r2.rowCount };
    } catch (e) {
      return { ok: false, reason: 'error_inspection_id', error: String(e?.message || e) };
    }
  }

  return { ok: false, reason: 'no_match' };
}

// ---------- Fleetio (placeholder) ----------
// Keep your existing Fleetio creation logic. I’m leaving a minimal call here
// so this file is drop-in if you want it. If you already have working code,
// preserve it; just ensure you call updateExistingInspection(...) with the right IDs.

async function createFleetioWorkOrder(input) {
  // You already have this working. Typical fields you pass along:
  // - asset_id / vehicle info
  // - line_items
  // - requested_by, notes, etc.
  //
  // Return shape expected by the client:
  //   { ok: true, work_order_id, work_order_number, url, ... }
  //
  // For safety, we just echo a stub if you haven’t wired this section.
  // Replace with your current Fleetio request code.
  return {
    ok: true,
    work_order_id: input?.mockWorkOrderId || 'WO-123456',
    work_order_number: input?.mockWorkOrderNumber || '000123',
    url: input?.mockUrl || 'https://fleetio.com/work_orders/WO-123456'
  };
}

// ---------- HTTP handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'Method Not Allowed' });
      return;
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    // These should already be coming from your client:
    const {
      // identifiers to find your inspection row
      recordId,              // preferred: your Neon row primary key
      inspectionId,          // acceptable alias: same value as id
      // stuff needed to create a WO (you already have this wired)
      fleetioPayload,        // your payload to Fleetio
      // optional doc bits to persist
      document_name,
      document_url
    } = body;

    // 1) Create Fleetio WO (your existing, working logic)
    const fleetioRes = await createFleetioWorkOrder(fleetioPayload);

    // 2) Persist the identifiers back to Neon
    let db_update = { ok: false, reason: 'skipped' };
    if (fleetioRes?.ok) {
      db_update = await updateExistingInspection({
        recordId,
        inspectionId,
        woId: fleetioRes.work_order_id,
        woNumber: fleetioRes.work_order_number,
        docName: document_name,
        docUrl: document_url
      });
    }

    // 3) Respond with everything the client already expects
    res.status(200).json({
      ok: !!fleetioRes?.ok,
      ...fleetioRes,
      db_update
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
