// /api/fleetio/create-work-order.js
// SIMPLE VERSION (fixed): robust vehicles loader normalizes API shape.
// - Exact vehicle lookup by Unit# == Fleetio vehicle `name` via GET /api/vehicles
// - Uses that vehicle's `id` and `primary_meter_value`
// - Creates WO (Open), attaches the EXACT PDF (no re-render), sets meter entries
// - If vehicle not found: returns 404 with choices (no "first vehicle" fallback)

export const config = { runtime: 'nodejs' };

const BASE_V1 = 'https://secure.fleetio.com/api';   // per your working call
const BASE_V2 = 'https://secure.fleetio.com/api/v2';
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

// ---------- Minimal DB idempotency (optional; safe if pg missing) ----------
let pgPool = null;
async function initDb() {
  try {
    const url = process.env.DATABASE_URL;
    if (!url) return null;
    if (pgPool) return pgPool;
    const { Pool } = await import('pg');
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

// Also mirror WO info onto your inspections table so you can hide the button
async function upsertInspectionWO(inspectionId, workOrderId, workOrderNumber) {
  try {
    const table = process.env.INSPECTIONS_TABLE || 'schedule4_inspections';
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
  } catch {/* non-fatal */}
}

// ---------- HTTP helpers ----------
async function fleetio(path, init = {}, step = 'fleetio') {
  const res = await fetch(`${BASE_V1}${path}`, { ...init, headers: { ...(init.headers||{}), ...defaultHeaders } });
  if (!res.ok) {
    const body = await res.text().catch(()=>'');
    const err = new Error(`[${step}] ${init.method||'GET'} ${path} failed: ${res.status} ${body}`);
    err.status = res.status; err.step = step; err.details = body; throw err;
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}
async function fleetioV2(path, init = {}, step = 'fleetioV2') {
  const res = await fetch(`${BASE_V2}${path}`, { ...init, headers: { ...(init.headers||{}), ...defaultHeaders } });
  if (!res.ok) {
    const body = await res.text().catch(()=>'');
    const err = new Error(`[${step}] ${init.method||'GET'} ${path} failed: ${res.status} ${body}`);
    err.status = res.status; err.step = step; err.details = body; throw err;
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

function normalize(s) { return String(s || '').trim().toLowerCase(); }
function numOrNull(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/,/g,'')); return Number.isFinite(n) ? n : null; }
function toIsoDate(dateLike) {
  if (!dateLike) return new Date().toISOString().slice(0, 10);
  const d = new Date(dateLike); return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0,10) : d.toISOString().slice(0,10);
}
function toInspectionDateTime(dateOnlyLike) {
  const d = String(toIsoDate(dateOnlyLike));
  return new Date(`${d}T15:00:00Z`).toISOString();
}
function sanitizeWorkOrderNumber(n){ if (n == null) return null; const s=String(n).trim(); return s.startsWith('#')?s.slice(1):s; }
function isPdf(buf) { try { return buf && buf.slice(0,5).toString('ascii') === '%PDF-'; } catch { return false; } }

// ---------- Vehicles loader (normalized to array) ----------
function asArray(maybe) {
  if (Array.isArray(maybe)) return maybe;
  if (maybe && Array.isArray(maybe.data)) return maybe.data;
  if (maybe && Array.isArray(maybe.records)) return maybe.records;
  // last resort: if object with numeric keys, use Object.values
  if (maybe && typeof maybe === 'object') return Object.values(maybe);
  return [];
}
async function getAllVehiclesSimple() {
  // Your working endpoint:
  //   GET https://secure.fleetio.com/api/vehicles
  const raw = await fleetio('/vehicles', {}, 'list_vehicles_simple');
  return asArray(raw);
}
function findVehicleByExactName(vehicles, unitName) {
  const target = normalize(unitName);
  if (!target) return null;
  return vehicles.find(v => normalize(v?.name) === target) || null;
}

// ---------- PDF upload (unchanged) ----------
const FLEETIO_UPLOAD_URL = FLEETIO_UPLOAD_ENDPOINT;
async function uploadPdfToFleetio(pdfBuffer, filename) {
  const policyResp = await fleetio('/uploads/policies', {
    method: 'POST',
    body: JSON.stringify({ filename: filename || 'schedule4.pdf', file_content_type: 'application/pdf' })
  }, 'get_upload_policy');
  const { policy, signature, path } = policyResp || {};
  if (!policy || !signature || !path) {
    const err = new Error('[upload_pdf] Policy response missing policy/signature/path');
    err.step = 'upload_pdf'; err.status = 500; err.details = JSON.stringify(policyResp).slice(0, 500);
    throw err;
  }
  const url = new URL(FLEETIO_UPLOAD_URL);
  url.searchParams.set('policy', policy);
  url.searchParams.set('signature', signature);
  url.searchParams.set('path', path);

  const up = await fetch(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdfBuffer });
  if (!up.ok) { const t = await up.text().catch(()=>''); throw Object.assign(new Error(`[upload_pdf] ${up.status} ${t}`), { step: 'upload_pdf', status: up.status, details: t }); }
  const j = await up.json().catch(()=>null);
  if (!j?.url) throw Object.assign(new Error('[upload_pdf] Upload response missing url'), { step: 'upload_pdf' });
  return j.url;
}

async function getOpenStatusId() {
  const out = await fleetio('/work_order_statuses', {}, 'get_open_status');
  const items = Array.isArray(out) ? out : (out?.records || out?.data || []);
  const open = items.find(s => normalize(s?.name) === 'open') || items.find(s => s?.is_default);
  if (!open?.id) throw Object.assign(new Error('Could not resolve "Open" status'), { step: 'get_open_status', status: 400 });
  return open.id;
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

    // Reuse if already created for this inspection
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

    // ----- VEHICLE: exact match on name (or explicit vehicleId)
    let vehicle = null;
    let finalVehicleId = vehicleIdFromBody || null;
    let currentMeterFromVehicle = null;

    if (!finalVehicleId) {
      const vehicles = await getAllVehiclesSimple(); // <- now always an array
      vehicle = findVehicleByExactName(vehicles, unitNumber);
      if (vehicle?.id) {
        finalVehicleId = vehicle.id;
        currentMeterFromVehicle = numOrNull(vehicle.primary_meter_value);
      }
    }

    if (!finalVehicleId) {
      const vehicles = await getAllVehiclesSimple();
      // choices safely map over array
      const choices = vehicles.map(v => ({ id: v.id, label: v.name || `Vehicle ${v.id}` }));
      return res.status(404).json({ code: 'vehicle_not_found', choices });
    }

    // ----- PDF: accept base64 or fetch via url (no re-render)
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

    // ----- Create WO (Open) & time stamps
    const inspectionDate = data.inspectionDate || data.dateInspected || data.date_inspected || null;
    const odometerFromForm = numOrNull(data.odometer ?? data.odometerStart ?? data.startOdometer);
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

    // Save so the UI can hide the button on reload
    await saveWO(inspectionId, workOrderId, workOrderNumber);
    await upsertInspectionWO(inspectionId, workOrderId, workOrderNumber);

    // ----- Meter entries (use your form ODO if present; otherwise Fleetio's current)
    const odometer = odometerFromForm ?? currentMeterFromVehicle ?? null;
    if (odometer != null) {
      const current = currentMeterFromVehicle;
      const markVoid = (current != null) ? (odometer > current) : false;

      try {
        await fleetioV2(`/work_orders/${workOrderId}`, {
          method: 'PATCH',
          body: JSON.stringify({
            starting_meter_entry_attributes: { value: odometer, void: !!markVoid },
            ending_meter_entry_attributes:   { value: odometer, void: !!markVoid }
          })
        }, 'patch_work_order_meters');
      } catch {/* non-fatal */}
    }

    // ----- Attach EXACT PDF (NO re-render)
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
      work_order_url: `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${workOrderNumber || workOrderId}/edit`
    });
  } catch (err) {
    console.error('Fleetio WO Error:', { step: err.step || 'unknown', status: err.status || 500, message: err.message, details: err.details?.slice?.(0,500) });
    return res.status(err.status || 500).json({ error: err.message, step: err.step || 'unknown', details: err.details || undefined });
  }
}
