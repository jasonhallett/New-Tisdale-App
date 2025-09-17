// /api/fleetio/create-work-order.js
// Creates a Fleetio Work Order in "Open", maps Date/Odometer, attaches the on-screen PDF,
// adds the "Schedule 4 Inspection (& EEPOC FMCSA 396.3)" task,
// and prevents duplicate creation per inspectionId via Neon (DATABASE_URL).

export const config = { runtime: 'nodejs' };

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

// -------- optional Neon DB (idempotency) --------
let pgPool = null;
async function initDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (pgPool) return pgPool;
  const { Pool } = await import('pg');
  pgPool = new Pool({ connectionString: url, max: 1, ssl: { rejectUnauthorized: false } });
  await pgPool.query(`CREATE TABLE IF NOT EXISTS fleetio_work_orders (
    inspection_id TEXT PRIMARY KEY,
    work_order_id BIGINT NOT NULL,
    work_order_number TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  return pgPool;
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

// -------- helpers --------
const defaultHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `Token ${API_TOKEN}`,
  'Account-Token': ACCOUNT_TOKEN
};

function normalize(s) { return String(s || '').trim().toLowerCase(); }

function toIsoDate(dateLike) {
  if (!dateLike) return new Date().toISOString().slice(0, 10);
  if (typeof dateLike === 'string') {
    const m = dateLike.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const [ , mm, dd, yyyy ] = m;
      const dt = new Date(`${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}T00:00:00Z`);
      return dt.toISOString().slice(0, 10);
    }
  }
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function toInspectionDateTime(dateOnlyLike) {
  // Use 15:00Z (11:00 ET during EDT) to avoid previous-day local rollover in America/Toronto
  const d = String(toIsoDate(dateOnlyLike));
  const ts = new Date(`${d}T15:00:00Z`);
  return ts.toISOString();
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const cleaned = String(v).replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function deriveOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  return `${proto}://${host}`;
}

// -------- Fleetio HTTP --------
async function fleetioV2(path, init = {}, step = 'fleetioV2') {
  const res = await fetch(`${BASE_V2}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), ...defaultHeaders }
  });
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
  const res = await fetch(`${BASE_V1}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), ...defaultHeaders }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`[${step}] Fleetio V1 ${init.method || 'GET'} ${path} failed: ${res.status} ${body}`);
    err.step = step; err.status = res.status; err.details = body;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// -------- Upload to Fleetio-managed storage --------
async function uploadPdfToFleetio(pdfBuffer, filename) {
  const policyResp = await fleetioV1('/uploads/policies', {
    method: 'POST',
    body: JSON.stringify({
      filename: filename || 'schedule4.pdf',
      file_content_type: 'application/pdf'
    })
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
  if (filename) url.searchParams.set('filename', filename);

  const up = await fetch(url.toString(), { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdfBuffer });
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    const err = new Error(`[upload_pdf] Binary upload failed: ${up.status} ${t}`);
    err.step = 'upload_pdf'; err.status = up.status; err.details = t;
    throw err;
  }
  const j = await up.json().catch(() => null);
  const fileUrl = j?.url;
  if (!fileUrl) {
    const err = new Error('[upload_pdf] Upload response missing url');
    err.step = 'upload_pdf'; err.status = 500; err.details = JSON.stringify(j).slice(0, 500);
    throw err;
  }
  return fileUrl;
}

// -------- Lookups --------
async function listAllVehicles() {
  const all = [];
  const PER_PAGE = 100;
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({ per_page: String(PER_PAGE) });
    if (cursor) params.set('start_cursor', cursor);
    const out = await fleetioV1(`/vehicles?${params.toString()}`, {}, 'list_vehicles');
    let records = Array.isArray(out) ? out : (out?.records || out?.data || []);
    const next = out?.next_cursor || null;
    if (records?.length) all.push(...records);
    if (!next) break;
    cursor = next;
  }
  if (all.length === 0) {
    let page = 1;
    for (let p = 0; p < 25; p++) {
      const qs = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
      const out = await fleetioV1(`/vehicles?${qs.toString()}`, {}, 'list_vehicles_fallback');
      const items = Array.isArray(out) ? out : (out?.data || out?.records || []);
      if (!items?.length) break;
      all.push(...items);
      if (items.length < PER_PAGE) break;
      page++;
    }
  }
  return all;
}

function vehicleLabel(v) { return v?.name || v?.vehicle_number || v?.external_id || v?.label || `Vehicle ${v?.id}`; }

function bestVehicleMatch(vehicles, unitNumber) {
  const t = normalize(unitNumber);
  if (!t) return null;
  for (const v of vehicles) {
    const candidates = [v?.name, v?.vehicle_number, v?.external_id, v?.label, v?.identifier, v?.unit, v?.unit_number, v?.number];
    if (candidates.some(c => normalize(c) === t)) return v;
  }
  for (const v of vehicles) {
    const lab = normalize(vehicleLabel(v));
    if (lab && lab.includes(t)) return v;
  }
  return null;
}

// Work Order Statuses (v1)
async function getOpenStatusId() {
  const PER_PAGE = 100;
  const params = new URLSearchParams({ per_page: String(PER_PAGE) });
  const out = await fleetioV1(`/work_order_statuses?${params.toString()}`, {}, 'get_open_status');
  const items = Array.isArray(out) ? out : (out?.records || out?.data || []);
  const open = items.find(s => normalize(s?.name) === 'open') || items.find(s => s?.is_default);
  if (!open?.id) {
    const err = new Error('[get_open_status] Could not resolve "Open" status');
    err.step = 'get_open_status'; err.status = 400;
    throw err;
  }
  return open.id;
}

function sanitizeWorkOrderNumber(n) {
  if (n == null) return null;
  const s = String(n).trim();
  return s.startsWith('#') ? s.slice(1) : s;
}

// -------- Handler --------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      inspectionId,
      filename,
      reportUrl,
      data = {},
      unitNumber,
      vehicleId: vehicleIdFromBody,
      serviceTaskName,
      pdfBase64
    } = req.body || {};

    if (!inspectionId) return res.status(400).json({ error: 'inspectionId is required' });
    const safeFilename = filename || `inspection_${inspectionId}.pdf`;
    const inspectionDate = data.inspectionDate || data.dateInspected || data.date_inspected || null;
    const odometer = numOrNull(data.odometer ?? data.odometerStart ?? data.startOdometer);

    // ---- idempotency: reuse existing WO if we've already made one for this inspection ----
    const existing = await getExistingWO(inspectionId);
    if (existing?.work_order_id) {
      const work_order_url = existing.work_order_number
        ? `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${sanitizeWorkOrderNumber(existing.work_order_number)}/edit`
        : `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${existing.work_order_id}/edit`;

      // Optionally still attach (will dedupe name visually in UI, which is acceptable) & ensure meters
      let pdfBuffer = null;
      let raw = pdfBase64;
      if (raw && typeof raw === 'string') {
        const idx = raw.indexOf(',');
        if (raw.startsWith('data:') && idx !== -1) raw = raw.slice(idx + 1);
        pdfBuffer = Buffer.from(raw, 'base64');
      }
      if (pdfBuffer) {
        const file_url = await uploadPdfToFleetio(pdfBuffer, safeFilename);
        await fleetioV2(`/work_orders/${existing.work_order_id}`, {
          method: 'PATCH',
          body: JSON.stringify({ documents_attributes: [ { name: safeFilename, file_url } ] })
        }, 'attach_document_existing');
      }
      return res.status(200).json({
        ok: true,
        reused: true,
        work_order_id: existing.work_order_id,
        work_order_number: sanitizeWorkOrderNumber(existing.work_order_number),
        work_order_url
      });
    }

    // 1) Resolve vehicle
    let finalVehicleId = vehicleIdFromBody || null;
    let allVehicles = null;
    if (!finalVehicleId) {
      allVehicles = await listAllVehicles();
      const match = bestVehicleMatch(allVehicles, unitNumber);
      if (match?.id) finalVehicleId = match.id;
    }
    if (!finalVehicleId) {
      const choices = (allVehicles || []).map(v => ({ id: v.id, label: vehicleLabel(v) }));
      return res.status(404).json({
        code: 'vehicle_not_found',
        message: `Could not find a Fleetio vehicle matching Unit "${unitNumber}". Pick one below.`,
        choices
      });
    }

    // 2) Resolve "Open" status
    const work_order_status_id = await getOpenStatusId();

    // 3) Create Work Order (v2) — issued/started at = Date Inspected (shifted to 15:00Z to avoid tz rollbacks)
    const issued_at = toInspectionDateTime(inspectionDate || new Date());
       const started_at = issued_at;

    const woPayload = {
      vehicle_id: finalVehicleId,
      work_order_status_id,
      issued_at,
      started_at
    };

    // Try optional idempotency header (if Fleetio ignores it, no harm)
    const idempotencyKey = `inspection:${inspectionId}`;

    const createdWO = await fleetioV2('/work_orders', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(woPayload)
    }, 'create_work_order');

    const workOrderId = createdWO?.id;
    if (!workOrderId) {
      const err = new Error('[create_work_order] No id returned');
      err.step = 'create_work_order'; err.status = 500;
      throw err;
    }

    let workOrderNumber = sanitizeWorkOrderNumber(createdWO?.number);
    if (!workOrderNumber) {
      const fetched = await fleetioV2(`/work_orders/${workOrderId}`, {}, 'fetch_work_order_number');
      workOrderNumber = sanitizeWorkOrderNumber(fetched?.number);
    }
    const work_order_url = workOrderNumber
      ? `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${workOrderNumber}/edit`
      : `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${workOrderId}/edit`;

    // Persist mapping to avoid duplicates on retries
    await saveWO(inspectionId, workOrderId, workOrderNumber);

    // 4) PDF: prefer client-provided base64. Fallback to print endpoint.
    let pdfBuffer = null;
    let raw = pdfBase64;
    if (raw && typeof raw === 'string') {
      const idx = raw.indexOf(',');
      if (raw.startsWith('data:') && idx !== -1) raw = raw.slice(idx + 1);
      try { pdfBuffer = Buffer.from(raw, 'base64'); } catch {}
    }
    if (!pdfBuffer) {
      if (!reportUrl) {
        const err = new Error('[render_pdf] reportUrl required when pdfBase64 is not provided');
        err.step = 'render_pdf_missing'; err.status = 400;
        throw err;
      }
      const origin = deriveOrigin(req);
      let absolute = reportUrl;
      if (!/^https?:\/\//i.test(absolute)) absolute = `${origin}${absolute.startsWith('/') ? '' : '/'}${absolute}`;
      try {
        const u = new URL(absolute);
        if (!u.searchParams.has('id') && inspectionId) u.searchParams.set('id', String(inspectionId));
        absolute = u.toString();
      } catch {}
      const printUrl = `${origin}/api/pdf/print`;
      const pr = await fetch(printUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: absolute, filename: safeFilename, data: data || {} })
      });
      if (!pr.ok) {
        const t = await pr.text().catch(() => '');
        const err = new Error(`[render_pdf] Printer failed: ${pr.status} ${t}`);
        err.step = 'render_pdf'; err.status = pr.status; err.details = t;
        throw err;
      }
      const ab = await pr.arrayBuffer();
      pdfBuffer = Buffer.from(ab);
    }

    const file_url = await uploadPdfToFleetio(pdfBuffer, safeFilename);
    await fleetioV2(`/work_orders/${workOrderId}`, {
      method: 'PATCH',
      body: JSON.stringify({ documents_attributes: [ { name: safeFilename, file_url } ] })
    }, 'attach_document');

    // 5) Ensure Service Task line item (v2), backed by Service Task (v1)
    const taskName = serviceTaskName || 'Schedule 4 Inspection (& EEPOC FMCSA 396.3)';
    async function findOrCreateServiceTaskId(name) {
      const PER_PAGE = 100;
      let cursor = null, found = null;
      for (let i = 0; i < 50 && !found; i++) {
        const params = new URLSearchParams({ per_page: String(PER_PAGE) });
        if (cursor) params.set('start_cursor', cursor);
        const out = await fleetioV1(`/service_tasks?${params.toString()}`, {}, 'list_service_tasks');
        const items = Array.isArray(out) ? out : (out?.records || out?.data || []);
        found = items.find(t => normalize(t?.name) === normalize(name)) || null;
        cursor = out?.next_cursor || null;
        if (!cursor) break;
      }
      if (found?.id) return found.id;
      const created = await fleetioV1('/service_tasks', { method: 'POST', body: JSON.stringify({ name }) }, 'create_service_task');
      if (!created?.id) {
        const err = new Error('[create_service_task] Service Task creation failed');
        err.step = 'create_service_task'; err.status = 500;
        throw err;
      }
      return created.id;
    }
    const serviceTaskId = await findOrCreateServiceTaskId(taskName);
    await fleetioV2(`/work_orders/${workOrderId}/work_order_line_items`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'WorkOrderServiceTaskLineItem',
        item_type: 'ServiceTask',
        item_id: serviceTaskId,
        description: taskName
      })
    }, 'create_line_item');

    // 6) Create starting & ending Meter Entries and (best-effort) link them on the WO
    let startMeterId = null, endMeterId = null;
    if (odometer != null) {
      const dateOnly = toIsoDate(inspectionDate || new Date());
      const startBody = {
        vehicle_id: finalVehicleId,
        value: odometer,
        date: dateOnly,
        category: 'starting',
        meterable_type: 'WorkOrder',
        meterable_id: workOrderId
      };
      const start = await fleetioV1('/meter_entries', { method: 'POST', body: JSON.stringify(startBody) }, 'create_start_meter');
      startMeterId = start?.id || null;

      const endBody = {
        vehicle_id: finalVehicleId,
        value: odometer,
        date: dateOnly,
        category: 'ending',
        meterable_type: 'WorkOrder',
        meterable_id: workOrderId
      };
      const end = await fleetioV1('/meter_entries', { method: 'POST', body: JSON.stringify(endBody) }, 'create_end_meter');
      endMeterId = end?.id || null;

      // Best-effort: PATCH the WO to explicitly point to these meter entries (if API supports it)
      try {
        const patch = {};
        if (startMeterId) patch.starting_meter_entry_id = startMeterId;
        if (endMeterId) patch.ending_meter_entry_id = endMeterId;
        if (Object.keys(patch).length) {
          await fleetioV2(`/work_orders/${workOrderId}`, { method: 'PATCH', body: JSON.stringify(patch) }, 'link_meters_to_wo');
        }
      } catch (e) {
        // non-fatal if not supported
        console.warn('link_meters_to_wo failed (non-fatal):', e?.status, e?.message);
      }
    }

    return res.status(200).json({
      ok: true,
      work_order_id: workOrderId,
      work_order_number: workOrderNumber,
      work_order_url,
      attached_document_url: file_url,
      meters: { startMeterId, endMeterId }
    });
  } catch (err) {
    console.error('Fleetio WO Error:', {
      step: err.step || 'unknown',
      status: err.status || 500,
      message: err.message,
      details: err.details?.slice?.(0, 1000)
    });
    return res.status(err.status || 500).json({
      error: err.message,
      step: err.step || 'unknown',
      details: err.details || undefined
    });
  }
}
