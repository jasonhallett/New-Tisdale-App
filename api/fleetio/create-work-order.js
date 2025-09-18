// /api/fleetio/create-work-order.js
// Hardened: graceful env validation (400), rich error details (never raw 500 unless truly fatal),
// optional Neon persistence, exact vehicle-by-name, meter entries (void if needed), PDF attach.
//
// Also includes GET ?ping=1 to verify env/config quickly on Vercel.
//
// Runtime: Node (not Edge) because we use Buffer and optional 'pg'

export const config = { runtime: 'nodejs' };

const BASE_V1 = 'https://secure.fleetio.com/api';
const BASE_V2 = 'https://secure.fleetio.com/api/v2';
const FLEETIO_UPLOAD_ENDPOINT = 'https://lmuavc3zg4.execute-api.us-east-1.amazonaws.com/prod/uploads';

function getEnv(name) {
  return process.env[name] ?? '';
}
function needEnv(name) {
  const v = getEnv(name).trim();
  if (!v) return { ok: false, name };
  return { ok: true, value: v };
}

function normalize(s){ return String(s||'').trim().toLowerCase(); }
function numOrNull(v){
  if (v==null || v==='') return null;
  const n = Number(String(v).replace(/,/g,'').trim());
  return Number.isFinite(n) ? n : null;
}
function toIsoDate(dateLike){
  if(!dateLike) return new Date().toISOString().slice(0,10);
  const d = new Date(dateLike);
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0,10) : d.toISOString().slice(0,10);
}
function toDateTime(dateOnly){
  const d = String(toIsoDate(dateOnly));
  // afternoon UTC to avoid TZ surprises in Fleetio UI
  return new Date(`${d}T15:00:00Z`).toISOString();
}
function sanitizeNumber(n){
  if(n==null) return null;
  const s=String(n).trim();
  return s.startsWith('#') ? s.slice(1) : s;
}
function isPdf(buf){
  try { return buf && buf.slice(0,5).toString('ascii') === '%PDF-'; }
  catch { return false; }
}
function asArray(maybe){
  if (Array.isArray(maybe)) return maybe;
  if (maybe?.data && Array.isArray(maybe.data)) return maybe.data;
  if (maybe?.records && Array.isArray(maybe.records)) return maybe.records;
  return [];
}

function jsonHeaders(extra = {}) {
  const API_TOKEN = getEnv('FLEETIO_API_TOKEN').trim();
  const ACCOUNT_TOKEN = getEnv('FLEETIO_ACCOUNT_TOKEN').trim();
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Token ${API_TOKEN}`,
    'Account-Token': ACCOUNT_TOKEN,
    ...extra
  };
}

// ---------- Optional Neon (idempotency / storage) ----------
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
  try {
    const pool = await initDb();
    if (!pool) return null;
    const { rows } = await pool.query(
      'SELECT work_order_id, work_order_number FROM fleetio_work_orders WHERE inspection_id = $1',
      [inspectionId]
    );
    return rows[0] || null;
  } catch { return null; }
}
async function saveWO(inspectionId, workOrderId, workOrderNumber) {
  try {
    const pool = await initDb();
    if (!pool) return;
    await pool.query(
      'INSERT INTO fleetio_work_orders (inspection_id, work_order_id, work_order_number) VALUES ($1,$2,$3) ON CONFLICT (inspection_id) DO NOTHING',
      [inspectionId, workOrderId, workOrderNumber]
    );
  } catch {}
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
  const res = await fetch(`${BASE_V1}${path}`, { ...init, headers: jsonHeaders(init.headers) });
  if (!res.ok) {
    const body = await res.text().catch(()=> '');
    const err = new Error(`[${step}] ${init.method||'GET'} ${path} failed: ${res.status} ${body}`);
    err.status = res.status; err.step = step; err.details = body;
    throw err;
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}
async function fleetioV2(path, init = {}, step = 'fleetioV2') {
  const res = await fetch(`${BASE_V2}${path}`, { ...init, headers: jsonHeaders(init.headers) });
  if (!res.ok) {
    const body = await res.text().catch(()=> '');
    const err = new Error(`[${step}] ${init.method||'GET'} ${path} failed: ${res.status} ${body}`);
    err.status = res.status; err.step = step; err.details = body;
    throw err;
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

// ---------- Fleetio helpers ----------
async function listVehicles(){
  return asArray(await fleetio('/vehicles', {}, 'vehicles'));
}
function findByExactName(vehicles, name){
  const n = normalize(name);
  return vehicles.find(v => normalize(v?.name) === n) || null;
}
async function uploadPdf(pdfBuffer, filename){
  const policy = await fleetio('/uploads/policies', {
    method:'POST',
    body: JSON.stringify({ filename: filename || 'schedule4.pdf', file_content_type: 'application/pdf' })
  }, 'upload_policy');

  const { policy:pol, signature, path } = policy || {};
  if(!pol || !signature || !path){
    const err = new Error('upload policy missing pieces');
    err.step = 'upload_pdf';
    throw err;
  }

  const url = new URL(FLEETIO_UPLOAD_ENDPOINT);
  url.searchParams.set('policy', pol);
  url.searchParams.set('signature', signature);
  url.searchParams.set('path', path);

  const up = await fetch(url.toString(), { method:'POST', headers:{'Content-Type':'application/pdf'}, body: pdfBuffer });
  if(!up.ok){
    const t = await up.text().catch(()=> '');
    const err = new Error(`[upload_pdf] ${up.status} ${t}`);
    err.step = 'upload_pdf';
    throw err;
  }
  const j = await up.json().catch(()=> null);
  if(!j?.url){
    const err = new Error('upload response missing url');
    err.step = 'upload_pdf';
    throw err;
  }
  return j.url;
}

// ---------- Handler ----------
export default async function handler(req, res){
  // Health check to catch env mistakes without hitting full flow
  if (req.method === 'GET' && (req.query?.ping || req.query?.health)) {
    const needApi = needEnv('FLEETIO_API_TOKEN');
    const needAcct= needEnv('FLEETIO_ACCOUNT_TOKEN');
    const miss = [needApi, needAcct].filter(x => !x.ok).map(x => x.name);
    if (miss.length) return res.status(400).json({ ok:false, error:'Missing env', missing: miss });
    return res.status(200).json({ ok:true, account: getEnv('FLEETIO_ACCOUNT_TOKEN') });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow','POST, GET');
    return res.status(405).json({ error:'Method not allowed' });
  }

  // Validate env FIRST – return 400 with specifics (avoid 500 + Function Invocation Failed)
  const needApi = needEnv('FLEETIO_API_TOKEN');
  const needAcct= needEnv('FLEETIO_ACCOUNT_TOKEN');
  const missing = [needApi, needAcct].filter(x => !x.ok).map(x => x.name);
  if (missing.length) {
    return res.status(400).json({
      error: 'Missing required environment variables',
      missing,
      hint: 'Set these in Vercel → Project → Settings → Environment Variables'
    });
  }

  try {
    const { inspectionId, unitNumber, filename, pdfBase64, pdfUrl, data = {}, vehicleId: overrideId } = req.body || {};
    if(!inspectionId) return res.status(400).json({ error:'inspectionId is required', step:'validate' });

    // Idempotency by inspectionId
    const existing = await getExistingWO(inspectionId);
    if (existing?.work_order_id) {
      await upsertInspectionWO(inspectionId, existing.work_order_id, sanitizeNumber(existing.work_order_number));
      const n = sanitizeNumber(existing.work_order_number);
      return res.status(200).json({
        ok:true, reused:true,
        work_order_id: existing.work_order_id,
        work_order_number: n,
        work_order_url: `https://secure.fleetio.com/${getEnv('FLEETIO_ACCOUNT_TOKEN')}/work_orders/${n || existing.work_order_id}/edit`
      });
    }

    // Vehicle resolution
    let vehicleId = overrideId || null;
    let currentMeter = null;
    if(!vehicleId){
      if(!unitNumber || !unitNumber.trim()) {
        return res.status(400).json({ error:'unitNumber is required', step:'validate' });
      }
      const list = await listVehicles();
      const veh  = findByExactName(list, unitNumber);
      if(!veh) {
        return res.status(404).json({
          code:'vehicle_not_found',
          step:'vehicles',
          message:`No Fleetio vehicle matches exact name "${unitNumber}"`,
          choices: list.slice(0,200).map(v=>({ id:v.id, name:v.name, primary_meter_value:v.primary_meter_value }))
        });
      }
      vehicleId = veh.id;
      currentMeter = numOrNull(veh.primary_meter_value);
    }

    // PDF intake
    let pdfBuffer = null;
    if (typeof pdfBase64 === 'string' && pdfBase64.length > 50) {
      let raw = pdfBase64;
      const idx = raw.indexOf(',');
      if (raw.startsWith('data:') && idx !== -1) raw = raw.slice(idx+1);
      try { pdfBuffer = Buffer.from(raw, 'base64'); } catch {}
    }

    // If base64 missing/invalid, try to fetch pdfUrl server-side (propagate cookies)
    if((!pdfBuffer || !isPdf(pdfBuffer)) && pdfUrl){
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const host  = req.headers['x-forwarded-host'] || req.headers['host'];
      const origin = `${proto}://${host}`;
      const abs = new URL(pdfUrl, origin).toString();

      const headers = { 'Accept': 'application/pdf,*/*' };
      if (req.headers.cookie) headers['cookie'] = req.headers.cookie;
      if (req.headers['accept-language']) headers['accept-language'] = req.headers['accept-language'];
      if (req.headers['user-agent']) headers['user-agent'] = req.headers['user-agent'];

      const resp = await fetch(abs, { headers, redirect: 'follow' });
      if (resp.ok) {
        const ab = await resp.arrayBuffer(); const b = Buffer.from(ab);
        if (isPdf(b)) pdfBuffer = b;
      } else {
        const t = await resp.text().catch(()=> '');
        return res.status(400).json({ error:`Could not fetch pdfUrl: ${resp.status}`, step:'fetch_pdf', details: t.slice(0,300) });
      }
    }
    if(!pdfBuffer || !isPdf(pdfBuffer)) {
      return res.status(400).json({ error:'Could not obtain a real PDF to attach. Provide pdfBase64 or pdfUrl to the actual file.', step:'pdf' });
    }

    // Resolve Open status
    const statuses = asArray(await fleetio('/work_order_statuses', {}, 'wo_status'));
    const open = statuses.find(s => normalize(s?.name) === 'open') || statuses.find(s => s?.is_default);
    const work_order_status_id = open?.id;
    if(!work_order_status_id) return res.status(400).json({ error:'Could not resolve Open status', step:'wo_status' });

    // Create work order
    const inspectionDate = data.inspectionDate || data.dateInspected;
    const issued_at  = toDateTime(inspectionDate || new Date());
    const started_at = issued_at;

    const created = await fleetioV2('/work_orders', {
      method:'POST',
      headers:{ 'Idempotency-Key': `inspection:${inspectionId}` },
      body: JSON.stringify({ vehicle_id: vehicleId, work_order_status_id, issued_at, started_at })
    }, 'create_wo');

    const workOrderId = created?.id;
    let workOrderNumber = sanitizeNumber(created?.number);
    if(!workOrderId) return res.status(502).json({ error:'No work order id returned', step:'create_wo' });

    if(!workOrderNumber){
      const fetched = await fleetioV2(`/work_orders/${workOrderId}`, {}, 'fetch_wo');
      workOrderNumber = sanitizeNumber(fetched?.number);
    }

    await saveWO(inspectionId, workOrderId, workOrderNumber);
    await upsertInspectionWO(inspectionId, workOrderId, workOrderNumber);

    // meters (from inspection or current)
    const odometerFromForm = numOrNull(data.odometer);
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
      } catch (e) {
        // Return success but expose meter patch failure for your modal
        return res.status(200).json({
          ok:true,
          work_order_id: workOrderId,
          work_order_number: workOrderNumber,
          work_order_url: `https://secure.fleetio.com/${getEnv('FLEETIO_ACCOUNT_TOKEN')}/work_orders/${workOrderNumber || workOrderId}/edit`,
          warn: 'meter_patch_failed',
          warn_details: e?.message || String(e)
        });
      }
    }

    // attach PDF
    const filenameSafe = filename || `Schedule4_${toIsoDate(inspectionDate || new Date())}.pdf`;
    const file_url = await uploadPdf(pdfBuffer, filenameSafe);
    await fleetioV2(`/work_orders/${workOrderId}`, {
      method:'PATCH',
      body: JSON.stringify({ documents_attributes: [ { name: filenameSafe, file_url } ] })
    }, 'attach_doc');

    return res.status(200).json({
      ok:true,
      work_order_id: workOrderId,
      work_order_number: workOrderNumber,
      work_order_url: `https://secure.fleetio.com/${getEnv('FLEETIO_ACCOUNT_TOKEN')}/work_orders/${workOrderNumber || workOrderId}/edit`
    });

  } catch (err) {
    // Never swallow; always return JSON with step + status
    console.error('create-work-order error:', {
      step: err.step || 'unknown',
      status: err.status || 500,
      message: err.message,
      details: err.details?.slice?.(0,400)
    });
    return res.status(err.status || 500).json({
      error: err.message || 'Server error',
      step: err.step || 'unknown',
      details: (err.details && typeof err.details === 'string') ? err.details.slice(0,400) : undefined
    });
  }
}
