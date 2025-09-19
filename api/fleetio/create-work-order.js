// /api/fleetio/create-work-order.js
// Stable core preserved (PDF attach, vehicle match, idempotency).
// Changes in this revision:

// Runtime: Node (not Edge)

export const config = { runtime: 'nodejs' };

const BASE_V1 = 'https://secure.fleetio.com/api';
const BASE_V2 = 'https://secure.fleetio.com/api/v2';
const FLEETIO_UPLOAD_ENDPOINT = 'https://lmuavc3zg4.execute-api.us-east-1.amazonaws.com/prod/uploads';

function getEnv(n){ return process.env[n] ?? ''; }
function needEnv(n){ const v=(getEnv(n)||'').trim(); return v?{ok:true,value:v}:{ok:false,name:n}; }
function normalize(s){ return String(s||'').trim().toLowerCase(); }
function numOrNull(v){ if(v==null||v==='') return null; const n=Number(String(v).replace(/,/g,'').trim()); return Number.isFinite(n)?n:null; }
function toIsoDate(dLike){ if(!dLike) return new Date().toISOString().slice(0,10); const d=new Date(dLike); return Number.isNaN(d.getTime())?new Date().toISOString().slice(0,10):d.toISOString().slice(0,10); }
function sanitizeNumber(n){ if(n==null) return null; const s=String(n).trim(); return s.startsWith('#')?s.slice(1):s; }
function isPdf(buf){ try{return buf && buf.slice(0,5).toString('ascii')==='%PDF-';}catch{return false;} }
function asArray(m){ if(Array.isArray(m)) return m; if(m?.data&&Array.isArray(m.data)) return m.data; if(m?.records&&Array.isArray(m.records)) return m.records; return []; }

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

// ---------- Optional Neon (idempotency store) ----------
let pgPool=null;
async function initDb(){ try{ const url=process.env.DATABASE_URL; if(!url) return null; if(pgPool) return pgPool; const {Pool}=await import('pg'); pgPool=new Pool({connectionString:url,max:1,ssl:{rejectUnauthorized:false}}); await pgPool.query(`
  CREATE TABLE IF NOT EXISTS fleetio_work_orders(
    inspection_id TEXT PRIMARY KEY,
    work_order_id BIGINT NOT NULL,
    work_order_number TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`); return pgPool; }catch{return null;} }
async function getExistingWO(id){ try{ const p=await initDb(); if(!p) return null; const {rows}=await p.query('SELECT work_order_id, work_order_number FROM fleetio_work_orders WHERE inspection_id=$1',[id]); return rows[0]||null; }catch{return null;} }
async function saveWO(id,woId,woNum){ try{ const p=await initDb(); if(!p) return; await p.query('INSERT INTO fleetio_work_orders (inspection_id,work_order_id,work_order_number) VALUES ($1,$2,$3) ON CONFLICT (inspection_id) DO NOTHING',[id,woId,woNum]); }catch{} }
async function upsertInspectionWO(id,woId,woNum){ try{ const table=process.env.INSPECTIONS_TABLE||'schedule4_inspections'; const p=await initDb(); if(!p) return; await p.query(
  `INSERT INTO ${table} (inspection_id, internal_work_order_number, fleetio_work_order_id)
   VALUES ($1,$2,$3)
   ON CONFLICT (inspection_id) DO UPDATE SET internal_work_order_number=EXCLUDED.internal_work_order_number, fleetio_work_order_id=EXCLUDED.fleetio_work_order_id, updated_at=now()`,
  [id, woNum||null, woId||null]); }catch{} }

// ---------- HTTP helpers ----------
async function fleetio(path, init={}, step='fleetio'){
  const res = await fetch(`${BASE_V1}${path}`, { ...init, headers: jsonHeaders(init.headers) });
  if(!res.ok){ const body=await res.text().catch(()=> ''); const err=new Error(`[${step}] ${init.method||'GET'} ${path} failed: ${res.status} ${body}`); err.status=res.status; err.step=step; err.details=body; throw err; }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}
async function fleetioV2(path, init={}, step='fleetioV2'){
  const res = await fetch(`${BASE_V2}${path}`, { ...init, headers: jsonHeaders(init.headers) });
  if(!res.ok){ const body=await res.text().catch(()=> ''); const err=new Error(`[${step}] ${init.method||'GET'} ${path} failed: ${res.status} ${body}`); err.status=res.status; err.step=step; err.details=body; throw err; }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

// ---------- Fleetio helpers ----------
async function listVehicles(){ return asArray(await fleetio('/vehicles', {}, 'vehicles')); }
function findByExactName(vehicles, name){ const n=normalize(name); return vehicles.find(v=>normalize(v?.name)===n)||null; }
async function uploadPdf(pdfBuffer, filename){
  const policy = await fleetio('/uploads/policies', { method: 'POST', body: JSON.stringify({ filename: filename||'schedule4.pdf', file_content_type: 'application/pdf' }) }, 'upload_policy');
  const { policy:pol, signature, path } = policy || {};
  if(!pol||!signature||!path){ const err=new Error('upload policy missing pieces'); err.step='upload_pdf'; throw err; }
  const url=new URL(FLEETIO_UPLOAD_ENDPOINT); url.searchParams.set('policy',pol); url.searchParams.set('signature',signature); url.searchParams.set('path',path); if(filename) url.searchParams.set('filename',filename);
  const up = await fetch(url.toString(), { method:'POST', headers:{'Content-Type':'application/pdf'}, body: pdfBuffer });
  if(!up.ok){ const t=await up.text().catch(()=> ''); const err=new Error(`[upload_pdf] ${up.status} ${t}`); err.step='upload_pdf'; throw err; }
  const j=await up.json().catch(()=> null); if(!j?.url){ const err=new Error('upload response missing url'); err.step='upload_pdf'; throw err; }
  return j.url;
}

// ---------- Handler ----------
export default async function handler(req, res){
  // Health check
  if(req.method==='GET' && (req.query?.ping || req.query?.health)){
    const miss=[needEnv('FLEETIO_API_TOKEN'),needEnv('FLEETIO_ACCOUNT_TOKEN')].filter(x=>!x.ok).map(x=>x.name);
    return miss.length?res.status(400).json({ok:false,error:'Missing env',missing:miss}):res.status(200).json({ok:true,account:getEnv('FLEETIO_ACCOUNT_TOKEN')});
  }
  if(req.method!=='POST'){ res.setHeader('Allow','POST, GET'); return res.status(405).json({error:'Method not allowed'}); }

  const miss=[needEnv('FLEETIO_API_TOKEN'),needEnv('FLEETIO_ACCOUNT_TOKEN')].filter(x=>!x.ok).map(x=>x.name);
  if(miss.length){ return res.status(400).json({error:'Missing required environment variables',missing:miss}); }

  try{
    const { inspectionId, unitNumber, filename, pdfBase64, pdfUrl, data = {}, vehicleId: overrideId } = req.body || {};
    if(!inspectionId) return res.status(400).json({ error:'inspectionId is required', step:'validate' });

    // Idempotency by inspectionId
    const existing = await getExistingWO(inspectionId);
    if(existing?.work_order_id){
      await upsertInspectionWO(inspectionId, existing.work_order_id, sanitizeNumber(existing.work_order_number));
      const n = sanitizeNumber(existing.work_order_number);
      return res.status(200).json({ ok:true, reused:true, work_order_id: existing.work_order_id, work_order_number: n, work_order_url: `https://secure.fleetio.com/${getEnv('FLEETIO_ACCOUNT_TOKEN')}/work_orders/${n||existing.work_order_id}/edit` });
    }

    // Vehicle resolution
    let vehicleId = overrideId || null;
    let currentMeter = null;
    if(!vehicleId){
      if(!unitNumber || !unitNumber.trim()) return res.status(400).json({ error:'unitNumber is required', step:'validate' });
      const list = await listVehicles();
      const veh  = findByExactName(list, unitNumber);
      if(!veh){
        return res.status(404).json({ code:'vehicle_not_found', step:'vehicles', message:`No Fleetio vehicle matches exact name "${unitNumber}"`,
          choices: list.slice(0,200).map(v=>({ id:v.id, name:v.name, primary_meter_value:v.primary_meter_value })) });
      }
      vehicleId   = veh.id;
      currentMeter= numOrNull(veh.primary_meter_value);
    }

    // PDF intake
    let pdfBuffer=null;
    if(typeof pdfBase64==='string' && pdfBase64.length>50){
      let raw=pdfBase64; const idx=raw.indexOf(',');
      if(raw.startsWith('data:') && idx!==-1) raw=raw.slice(idx+1);
      try{ pdfBuffer=Buffer.from(raw,'base64'); }catch{}
    }
    if((!pdfBuffer || !isPdf(pdfBuffer)) && pdfUrl){
      const proto=req.headers['x-forwarded-proto']||'https'; const host=req.headers['x-forwarded-host']||req.headers['host']; const origin=`${proto}://${host}`;
      const abs=new URL(pdfUrl, origin).toString();
      const headers={'Accept':'application/pdf,*/*'}; if(req.headers.cookie) headers.cookie=req.headers.cookie; if(req.headers['accept-language']) headers['accept-language']=req.headers['accept-language']; if(req.headers['user-agent']) headers['user-agent']=req.headers['user-agent'];
      const r=await fetch(abs,{headers,redirect:'follow'}); if(r.ok){ const ab=await r.arrayBuffer(); const b=Buffer.from(ab); if(isPdf(b)) pdfBuffer=b; } else { const t=await r.text().catch(()=> ''); return res.status(400).json({ error:`Could not fetch pdfUrl: ${r.status}`, step:'fetch_pdf', details:t.slice(0,300) }); }
    }
    if(!pdfBuffer || !isPdf(pdfBuffer)){ return res.status(400).json({ error:'Could not obtain a real PDF to attach. Provide pdfBase64 or pdfUrl to the actual file.', step:'pdf' }); }

    // Resolve Open status
    const statuses = asArray(await fleetio('/work_order_statuses', {}, 'wo_status'));
    const open = statuses.find(s=>normalize(s?.name)==='open') || statuses.find(s=>s?.is_default);
    const work_order_status_id = open?.id;
    if(!work_order_status_id) return res.status(400).json({ error:'Could not resolve Open status', step:'wo_status' });

    // Timestamps and meter values
    const started_at = new Date().toISOString();
    const ended_at   = started_at; // same instant
    const odoFromForm = numOrNull(data.odometer);
    const odo = odoFromForm ?? currentMeter ?? null;


    const markVoid = false;

    // --- CREATE with starting meter and same-as-start flag ---
    const createBody = { vehicle_id: vehicleId, work_order_status_id, issued_at: started_at, started_at, ended_at };
    if(odo!=null){
      createBody.starting_meter_entry_attributes = { value: odo, void: !!markVoid };
      createBody.ending_meter_same_as_start = true;
    }

    let created, createErr = null;
    try{
      created = await fleetioV2('/work_orders', { method:'POST', headers:{ 'Idempotency-Key': `inspection:${inspectionId}` }, body: JSON.stringify(createBody) }, 'create_wo');
    }catch(e){
      createErr = e;
      // Fallback: create without meters, then PATCH meters with same-as-start flag
      created = await fleetioV2('/work_orders', { method:'POST', headers:{ 'Idempotency-Key': `inspection:${inspectionId}:no-meters` }, body: JSON.stringify({ vehicle_id: vehicleId, work_order_status_id, issued_at: started_at, started_at, ended_at }) }, 'create_wo_nometers');
    }

    const workOrderId = created?.id;
    let workOrderNumber = sanitizeNumber(created?.number);
    if(!workOrderId) return res.status(502).json({ error:'No work order id returned', step:'create_wo' });
    if(!workOrderNumber){
      const fetched = await fleetioV2(`/work_orders/${workOrderId}`, {}, 'fetch_wo');
      workOrderNumber = sanitizeNumber(fetched?.number);
    }

    // Persist to DBs; if Neon missing, surface a non-fatal warn in the response for your modal
    const warnList = [];
    try { await saveWO(inspectionId, workOrderId, workOrderNumber); } catch { warnList.push({code:'db_save_wo_failed'}); }
    try { await upsertInspectionWO(inspectionId, workOrderId, workOrderNumber); } catch { warnList.push({code:'db_upsert_inspection_failed'}); }

    // If meters were rejected on create, try to PATCH with the same-as-start flag
    if(createErr && odo!=null){
      try{
        await fleetioV2(`/work_orders/${workOrderId}`, {
          method:'PATCH',
          body: JSON.stringify({
            started_at, ended_at,
            starting_meter_entry_attributes: { value: odo, void: !!markVoid },
            ending_meter_same_as_start: true
          })
        }, 'patch_meters_after_create');
      }catch(e2){
        warnList.push({ code:'meter_patch_failed', details: e2?.message || String(e2) });
      }
    }

    // Attach PDF (always)
    const filenameSafe = filename || `Schedule4_${toIsoDate(data.inspectionDate || new Date())}.pdf`;
    const file_url = await uploadPdf(pdfBuffer, filenameSafe);
    try{
      await fleetioV2(`/work_orders/${workOrderId}`, { method:'PATCH', body: JSON.stringify({ documents_attributes: [ { name: filenameSafe, file_url } ] }) }, 'attach_doc');
    }catch(e){ warnList.push({ code:'attach_doc_failed', details: e?.message || String(e) }); }

    const response = {
      ok:true,
      work_order_id: workOrderId,
      work_order_number: workOrderNumber,
      work_order_url: `https://secure.fleetio.com/${getEnv('FLEETIO_ACCOUNT_TOKEN')}/work_orders/${workOrderNumber || workOrderId}/edit`
    };
    if (warnList.length) response.warn = warnList;
    if (createErr) response.warn = [...(response.warn||[]), { code: 'create_meters_rejected', details: createErr.message }];
    return res.status(200).json(response);

  }catch(err){
    console.error('create-work-order error:', { step: err.step || 'unknown', status: err.status || 500, message: err.message, details: err.details?.slice?.(0,400) });
    return res.status(err.status || 500).json({ error: err.message || 'Server error', step: err.step || 'unknown', details: (err.details && typeof err.details==='string') ? err.details.slice(0,400) : undefined });
  }
}
