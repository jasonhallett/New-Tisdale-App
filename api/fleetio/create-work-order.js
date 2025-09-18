// /api/fleetio/create-work-order.js
// DEBUG RESET: minimal server with robust PDF handling (pdfBase64 OR server-fetched pdfUrl),
// exact vehicle match by name, meters, Open status, document attach, and optional idempotency.
//
// Env:
//   - FLEETIO_API_TOKEN (required)
//   - FLEETIO_ACCOUNT_TOKEN (required) e.g., 80ce8e499c
//   - DATABASE_URL (optional Neon; enables idempotency table fleetio_work_orders)
//   - INSPECTIONS_TABLE (optional; defaults schedule4_inspections for button lock mirror)
export const config = { runtime: 'nodejs' };

const BASE_V1 = 'https://secure.fleetio.com/api';
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

// ---------- Optional Neon idempotency ----------
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
  const { rows } = await pool.query('SELECT work_order_id, work_order_number FROM fleetio_work_orders WHERE inspection_id = $1', [inspectionId]);
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
  } catch {}
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
function normalize(s){ return String(s||'').trim().toLowerCase(); }
function numOrNull(v){ if (v==null || v==='') return null; const n = Number(String(v).replace(/,/g,'')); return Number.isFinite(n)?n:null; }
function toIsoDate(dateLike){ if(!dateLike) return new Date().toISOString().slice(0,10); const d=new Date(dateLike); return Number.isNaN(d.getTime())?new Date().toISOString().slice(0,10):d.toISOString().slice(0,10); }
function toDateTime(dateOnly){ const d=String(toIsoDate(dateOnly)); return new Date(`${d}T15:00:00Z`).toISOString(); }
function sanitizeNumber(n){ if(n==null) return null; const s=String(n).trim(); return s.startsWith('#')?s.slice(1):s; }
function isPdf(buf){ try { return buf && buf.slice(0,5).toString('ascii')==='%PDF-'; } catch { return false; } }
function asArray(maybe){ if(Array.isArray(maybe)) return maybe; if(maybe?.data && Array.isArray(maybe.data)) return maybe.data; if(maybe?.records && Array.isArray(maybe.records)) return maybe.records; return []; }

// ---------- vehicles ----------
async function listVehicles(){ return asArray(await fleetio('/vehicles', {}, 'vehicles')); }
function findByExactName(vehicles, name){ const n=normalize(name); return vehicles.find(v => normalize(v?.name)===n) || null; }

// ---------- upload pdf ----------
async function uploadPdf(pdfBuffer, filename){
  const policy = await fleetio('/uploads/policies', { method:'POST', body: JSON.stringify({ filename: filename || 'schedule4.pdf', file_content_type: 'application/pdf' }) }, 'upload_policy');
  const { policy:pol, signature, path } = policy || {};
  if(!pol || !signature || !path) throw Object.assign(new Error('upload policy missing pieces'), { step:'upload_pdf' });

  const url = new URL(FLEETIO_UPLOAD_ENDPOINT);
  url.searchParams.set('policy', pol);
  url.searchParams.set('signature', signature);
  url.searchParams.set('path', path);

  const up = await fetch(url.toString(), { method:'POST', headers:{'Content-Type':'application/pdf'}, body: pdfBuffer });
  if(!up.ok){ const t=await up.text().catch(()=> ''); throw Object.assign(new Error(`[upload_pdf] ${up.status} ${t}`), { step:'upload_pdf' }); }
  const j = await up.json().catch(()=>null);
  if(!j?.url) throw Object.assign(new Error('upload response missing url'), { step:'upload_pdf' });
  return j.url;
}

export default async function handler(req, res){
  if(req.method!=='POST'){ res.setHeader('Allow','POST'); return res.status(405).json({ error:'Method not allowed' }); }

  try {
    const { inspectionId, unitNumber, filename, pdfBase64, pdfUrl, data = {}, vehicleId: overrideId } = req.body || {};
    if(!inspectionId) return res.status(400).json({ error:'inspectionId is required' });

    // Idempotency
    const existing = await getExistingWO(inspectionId);
    if (existing?.work_order_id) {
      await upsertInspectionWO(inspectionId, existing.work_order_id, sanitizeNumber(existing.work_order_number));
      const n = sanitizeNumber(existing.work_order_number);
      return res.status(200).json({ ok:true, reused:true, work_order_id: existing.work_order_id, work_order_number: n, work_order_url: `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${n || existing.work_order_id}/edit` });
    }

    // Vehicle
    let vehicleId = overrideId || null;
    let currentMeter = null;
    if(!vehicleId){
      if(!unitNumber || !unitNumber.trim()) return res.status(400).json({ error:'unitNumber is required' });
      const list = await listVehicles();
      const veh  = findByExactName(list, unitNumber);
      if(!veh) return res.status(404).json({ code:'vehicle_not_found', choices: list.map(v=>({ id:v.id, label: v.name || `Vehicle ${v.id}` })) });
      vehicleId = veh.id;
      currentMeter = numOrNull(veh.primary_meter_value);
    }

    // PDF
    let pdfBuffer = null;
    if(typeof pdfBase64==='string' && pdfBase64.length>50){
      let raw = pdfBase64;
      const idx = raw.indexOf(',');
      if (raw.startsWith('data:') && idx !== -1) raw = raw.slice(idx+1);
      try { pdfBuffer = Buffer.from(raw, 'base64'); } catch {}
    }
    // If base64 missing/invalid, allow server-fetch of pdfUrl (same-origin) with cookies
    if((!pdfBuffer || !isPdf(pdfBuffer)) && pdfUrl){
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host  = req.headers['x-forwarded-host'] || req.headers['host'];
      const origin = `${proto}://${host}`;
      const abs = new URL(pdfUrl, origin).toString();

      const headers = { 'Accept': 'application/pdf,*/*' };
      // Forward cookies (auth), language, UA if present
      if (req.headers.cookie) headers['cookie'] = req.headers.cookie;
      if (req.headers['accept-language']) headers['accept-language'] = req.headers['accept-language'];
      if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

      const resp = await fetch(abs, { headers });
      if (resp.ok) {
        const ab = await resp.arrayBuffer(); const b = Buffer.from(ab);
        if (isPdf(b)) pdfBuffer = b;
      } else {
        const t = await resp.text().catch(()=>'');
        return res.status(400).json({ error:`Could not fetch pdfUrl: ${resp.status}`, details: t.slice(0,300) });
      }
    }
    if(!pdfBuffer || !isPdf(pdfBuffer)) return res.status(400).json({ error:'Could not obtain a real PDF to attach. Provide pdfBase64 or pdfUrl to the actual file.' });

    // Create WO
    const inspectionDate = data.inspectionDate || data.dateInspected || null;
    const odometerFromForm = numOrNull(data.odometer);
    const statuses = asArray(await fleetio('/work_order_statuses', {}, 'wo_status'));
    const open = statuses.find(s => normalize(s?.name) === 'open') || statuses.find(s => s?.is_default);
    const work_order_status_id = open?.id;
    if(!work_order_status_id) return res.status(400).json({ error:'Could not resolve Open status' });

    const issued_at = toDateTime(inspectionDate || new Date());
    const started_at = issued_at;

    const created = await fleetioV2('/work_orders', {
      method:'POST',
      headers:{ 'Idempotency-Key': `inspection:${inspectionId}` },
      body: JSON.stringify({ vehicle_id: vehicleId, work_order_status_id, issued_at, started_at })
    }, 'create_wo');

    const workOrderId = created?.id;
    let workOrderNumber = sanitizeNumber(created?.number);
    if(!workOrderId) return res.status(500).json({ error:'No work order id returned' });
    if(!workOrderNumber){
      const fetched = await fleetioV2(`/work_orders/${workOrderId}`, {}, 'fetch_wo');
      workOrderNumber = sanitizeNumber(fetched?.number);
    }

    await saveWO(inspectionId, workOrderId, workOrderNumber);
    await upsertInspectionWO(inspectionId, workOrderId, workOrderNumber);

    // meters
    const odo = odometerFromForm ?? currentMeter ?? null;
    if (odo != null) {
      const markVoid = (currentMeter != null) ? (odo > currentMeter) : false;
      try {
        await fleetioV2(`/work_orders/${workOrderId}`, {
          method:'PATCH',
          body: JSON.stringify({
            starting_meter_entry_attributes: { value: odo, void: !!markVoid },
            ending_meter_entry_attributes:   { value: odo, void: !!markVoid }
          })
        }, 'patch_meters');
      } catch {}
    }

    // attach pdf
    const filenameSafe = filename || `Schedule4_${toIsoDate(inspectionDate || new Date())}.pdf";
    const file_url = await uploadPdf(pdfBuffer, filenameSafe);
    await fleetioV2(`/work_orders/${workOrderId}`, {
      method:'PATCH',
      body: JSON.stringify({ documents_attributes: [ { name: filenameSafe, file_url } ] })
    }, 'attach_doc');

    return res.status(200).json({
      ok:true,
      work_order_id: workOrderId,
      work_order_number: workOrderNumber,
      work_order_url: `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${workOrderNumber || workOrderId}/edit`
    });

  } catch (err) {
    console.error('create-work-order error:', { step: err.step || 'unknown', status: err.status || 500, message: err.message, details: err.details?.slice?.(0,400) });
    return res.status(err.status || 500).json({ error: err.message || 'Server error' });
  }
}
