// /api/fleetio/create-work-order.js
// Uses vehicle-matching for Unit# → Fleetio vehicle.id
// Saves WO id/number onto your Schedule 4 record so the UI can lock the button.

export const config = { runtime: 'nodejs' };

import { listAllVehicles, getVehicleIdForUnit, normalize } from '../fleetio/vehicle-matching.js';

const BASE_V2 = 'https://secure.fleetio.com/api/v2';
const BASE_V1 = 'https://secure.fleetio.com/api/v1';
const FLEETIO_UPLOAD_ENDPOINT = 'https://lmuavc3zg4.execute-api.us-east-1.amazonaws.com/prod/uploads';

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const API_TOKEN = requiredEnv('FLEETIO_API_TOKEN');
const ACCOUNT_TOKEN = requiredEnv('FLEETIO_ACCOUNT_TOKEN');

const defaultHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `Token ${API_TOKEN}`,
  'Account-Token': ACCOUNT_TOKEN
};

// optional Neon cache to prevent duplicate WO per inspection
let pgPool = null;
async function initDb() {
  try {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    if (pgPool) return pgPool;
    let Pool;
    ({ Pool } = await import('pg'));
    pgPool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS fleetio_work_orders (
        inspection_id TEXT PRIMARY KEY,
        work_order_id BIGINT NOT NULL,
        work_order_number TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `);
    return pgPool;
  } catch {
    return null;
  }
}
async function getExistingWO(inspectionId) {
  const pool = await initDb();
  if (!pool) return null;
  const { rows } = await pool.query(
    'SELECT work_order_id, work_order_number FROM fleetio_work_orders WHERE inspection_id = $1',
    [inspectionId]
  );
  return rows[0] || null;
}
async function saveWO(inspectionId, workOrderId, workOrderNumber) {
  const pool = await initDb();
  if (!pool) return null;
  await pool.query(
    'INSERT INTO fleetio_work_orders (inspection_id, work_order_id, work_order_number) VALUES ($1,$2,$3) ON CONFLICT (inspection_id) DO NOTHING',
    [inspectionId, workOrderId, workOrderNumber]
  );
}

// Save onto your inspections table
async function upsertInspectionWO(inspectionId, workOrderId, workOrderNumber) {
  const table = process.env.INSPECTIONS_TABLE || 'schedule4_inspections';
  try {
    const pool = await initDb();
    if (!pool) return;
    await pool.query(
      `INSERT INTO ${table} (inspection_id, internal_work_order_number, fleetio_work_order_id)
       VALUES ($1,$2,$3)
       ON CONFLICT (inspection_id)
       DO UPDATE SET internal_work_order_number = EXCLUDED.internal_work_order_number,
                     fleetio_work_order_id = EXCLUDED.fleetio_work_order_id,
                     updated_at = now()`,
      [inspectionId, workOrderNumber || null, workOrderId || null]
    );
  } catch (e) {
    console.warn('upsertInspectionWO warning:', e.message);
  }
}

// ---------- HTTP helpers ----------
async function fleetioV2(path, init = {}, step = 'fleetioV2') {
  const res = await fetch(`${BASE_V2}${path}`, { ...init, headers: { ...(init.headers||{}), ...defaultHeaders } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`[${step}] Fleetio V2 ${init.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    err.step = step; err.status = res.status; err.details = body;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}
async function fleetioV1(path, init = {}, step = 'fleetioV1') {
  const res = await fetch(`${BASE_V1}${path}`, { ...init, headers: { ...(init.headers||{}), ...defaultHeaders } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`[${step}] Fleetio V1 ${init.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    err.step = step; err.status = res.status; err.details = body;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ---------- PDF upload ----------
function isPdf(buf) { try { return buf && buf.slice(0,5).toString('ascii') === '%PDF-'; } catch { return false; } }
async function uploadPdfToFleetio(pdfBuffer, filename) {
  const policyResp = await fleetioV1('/uploads/policies', {
    method: 'POST',
    body: JSON.stringify({ filename: filename || 'schedule4.pdf', file_content_type: 'application/pdf' })
  }, 'get_upload_policy');
  const { policy, signature, path } = policyResp || {};
  if (!policy || !signature || !path) {
    const err = new Error('[upload_pdf] Policy response missing policy/signature/path');
    err.step = 'upload_pdf'; err.status = 500; err.details = JSON.stringify(policyResp).slice(0, 500);
    throw err;
  }
  const url = new URL(FLEETIO_UPLOAD_ENDPOINT);
  url.searchParams.set('policy', policy);
  url.searchParams.set('signature', signature);
  url.searchParams.set('path', path);

  const up = await fetch(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdfBuffer });
  if (!up.ok) { const t = await up.text().catch(()=>''); throw Object.assign(new Error(`[upload_pdf] ${up.status} ${t}`), { step: 'upload_pdf', status: up.status, details: t }); }
  const j = await up.json().catch(()=>null);
  if (!j?.url) throw Object.assign(new Error('[upload_pdf] Upload response missing url'), { step: 'upload_pdf' });
  return j.url;
}

// ---------- small utils ----------
function toIsoDate(dateLike) {
  if (!dateLike) return new Date().toISOString().slice(0, 10);
  const d = new Date(dateLike); return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0,10) : d.toISOString().slice(0,10);
}
function toInspectionDateTime(dateOnlyLike) {
  const d = String(toIsoDate(dateOnlyLike));
  return new Date(`${d}T15:00:00Z`).toISOString();
}
function numOrNull(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/,/g,'')); return Number.isFinite(n) ? n : null; }
function sanitizeWorkOrderNumber(n){ if (n == null) return null; const s=String(n).trim(); return s.startsWith('#')?s.slice(1):s; }

async function getOpenStatusId() {
  const params = new URLSearchParams({ per_page: '100' });
  const out = await fleetioV1(`/work_order_statuses?${params.toString()}`, {}, 'get_open_status');
  const items = Array.isArray(out) ? out : (out?.records || out?.data || []);
  const open = items.find(s => normalize(s?.name) === 'open') || items.find(s => s?.is_default);
  if (!open?.id) throw Object.assign(new Error('Could not resolve "Open" status'), { step: 'get_open_status', status: 400 });
  return open.id;
}

async function getCurrentMeterValue(vehicleId) {
  try {
    const v2 = await fleetioV2(`/vehicles/${vehicleId}`, {}, 'get_vehicle_v2');
    for (const f of ['current_meter_value','current_odometer','current_meter','meter_value','odometer']) {
      const val = v2?.[f]; if (val != null && Number.isFinite(Number(val))) return Number(val);
    }
  } catch {}
  try {
    const v1 = await fleetioV1(`/vehicles/${vehicleId}`, {}, 'get_vehicle_v1');
    for (const f of ['current_meter_value','current_odometer','meter_value','odometer']) {
      const val = v1?.[f]; if (val != null && Number.isFinite(Number(val))) return Number(val);
    }
  } catch {}
  try {
    const q = new URLSearchParams({ vehicle_id: String(vehicleId), per_page: '1' });
    const list = await fleetioV1(`/meter_entries?${q.toString()}`, {}, 'get_latest_meter_entry');
    const arr = Array.isArray(list) ? list : (list?.records || list?.data || []);
    const latest = arr?.[0]; const val = latest?.value;
    if (val != null && Number.isFinite(Number(val))) return Number(val);
  } catch {}
  return null;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  try {
    const {
      inspectionId,
      filename,
      data = {},
      unitNumber,
      vehicleId: vehicleIdFromBody,
      serviceTaskName,
      pdfBase64,
      pdfUrl
    } = req.body || {};

    if (!inspectionId) return res.status(400).json({ error: 'inspectionId is required' });

    // Idempotency: reuse WO if already created for this inspection
    const existing = await getExistingWO(inspectionId);
    if (existing?.work_order_id) {
      await upsertInspectionWO(inspectionId, existing.work_order_id, sanitizeWorkOrderNumber(existing.work_order_number));
      return res.status(200).json({
        ok: true,
        reused: true,
        work_order_id: existing.work_order_id,
        work_order_number: sanitizeWorkOrderNumber(existing.work_order_number),
        work_order_url: existing.work_order_number
          ? `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${sanitizeWorkOrderNumber(existing.work_order_number)}/edit`
          : `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${existing.work_order_id}/edit`
      });
    }

    // Resolve vehicle via explicit vehicleId or matching function
    let finalVehicleId = vehicleIdFromBody || null;
    if (!finalVehicleId && unitNumber) {
      const { id } = await getVehicleIdForUnit(unitNumber);
      if (id) finalVehicleId = id;
    }
    if (!finalVehicleId) {
      // do not create a WO; let client show picker
      const vehicles = await listAllVehicles();
      const choices = vehicles.map(v => ({ id: v.id, label: (v.vehicle_number || v.name || v.external_id || `Vehicle ${v.id}`) }));
      return res.status(404).json({ code: 'vehicle_not_found', choices });
    }

    // Prepare PDF (require either base64 or url; if url given, fetch exact bytes)
    let pdfBuffer = null;
    if (typeof pdfBase64 === 'string' && pdfBase64.length > 20) {
      let raw = pdfBase64;
      const idx = raw.indexOf(',');
      if (raw.startsWith('data:') && idx !== -1) raw = raw.slice(idx + 1);
      try { pdfBuffer = Buffer.from(raw, 'base64'); } catch {}
    }
    if ((!pdfBuffer || !isPdf(pdfBuffer)) && pdfUrl) {
      const origin = (req.headers['x-forwarded-proto'] ? req.headers['x-forwarded-proto'] : 'https') + '://' + (req.headers['x-forwarded-host'] || req.headers['host']);
      const abs = new URL(pdfUrl, origin).toString();
      const headers = { 'Accept': 'application/pdf,*/*' };
      if (req.headers.cookie) headers['cookie'] = req.headers.cookie;
      const resp = await fetch(abs, { headers });
      if (!resp.ok) { const t = await resp.text().catch(()=>''); return res.status(400).json({ error: `Could not fetch pdfUrl: ${resp.status}`, details: t.slice(0,200) }); }
      const ab = await resp.arrayBuffer(); const buf = Buffer.from(ab);
      if (isPdf(buf)) pdfBuffer = buf;
    }
    if (!pdfBuffer || !isPdf(pdfBuffer)) {
      return res.status(400).json({ error: 'Could not obtain a real PDF to attach. Provide pdfBase64 or pdfUrl to the actual file.' });
    }

    const inspectionDate = data.inspectionDate || data.dateInspected || data.date_inspected || null;
    const odometer       = numOrNull(data.odometer ?? data.odometerStart ?? data.startOdometer);

    // Create WO (idempotent)
    const issued_at  = toInspectionDateTime(inspectionDate || new Date());
    const started_at = issued_at;
    const work_order_status_id = await getOpenStatusId();

    const createdWO = await fleetioV2('/work_orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': `inspection:${inspectionId}` },
      body: JSON.stringify({ vehicle_id: finalVehicleId, work_order_status_id, issued_at, started_at })
    }, 'create_work_order');

    const workOrderId = createdWO?.id;
    let workOrderNumber = sanitizeWorkOrderNumber(createdWO?.number);
    if (!workOrderId) return res.status(500).json({ error: 'No work order id returned' });
    if (!workOrderNumber) {
      const fetched = await fleetioV2(`/work_orders/${workOrderId}`, {}, 'fetch_work_order_number');
      workOrderNumber = sanitizeWorkOrderNumber(fetched?.number);
    }

    // Save linkage to your inspections table (so UI can lock button)
    await saveWO(inspectionId, workOrderId, workOrderNumber);
    await upsertInspectionWO(inspectionId, workOrderId, workOrderNumber);

    const work_order_url = workOrderNumber
      ? `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${workOrderNumber}/edit`
      : `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${workOrderId}/edit`;

    // Set meters
    if (odometer != null) {
      const currentMeter = await getCurrentMeterValue(finalVehicleId);
      const markVoid = (currentMeter != null) ? (odometer > currentMeter) : false;
      try {
        await fleetioV2(`/work_orders/${workOrderId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            starting_meter_entry_attributes: { value: odometer, void: !!markVoid },
            ending_meter_entry_attributes:   { value: odometer, void: !!markVoid }
          })
        }, 'patch_work_order_meters');
      } catch {}
    }

    // Attach PDF
    const filenameSafe = filename || `Schedule4_${toIsoDate(inspectionDate || new Date())}.pdf`;
    const file_url = await uploadPdfToFleetio(pdfBuffer, filenameSafe);
    await fleetioV2(`/work_orders/${workOrderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ documents_attributes: [ { name: filenameSafe, file_url } ] })
    }, 'attach_document');

    return res.status(200).json({
      ok: true,
      work_order_id: workOrderId,
      work_order_number: workOrderNumber,
      work_order_url
    });
  } catch (err) {
    console.error('Fleetio WO Error:', { step: err.step || 'unknown', status: err.status || 500, message: err.message, details: err.details?.slice?.(0,500) });
    return res.status(err.status || 500).json({ error: err.message, step: err.step || 'unknown', details: err.details || undefined });
  }
}
