// /api/fleetio/create-work-order.js
// Creates a Fleetio Work Order in "Open", maps Date/Odometer, renders & attaches the PDF,
// and adds the "Schedule 4 Inspection (& EEPOC FMCSA 396.3)" Service Task as a line item.

export const config = { runtime: 'nodejs' };

const BASE_V2 = 'https://secure.fleetio.com/api/v2';
const BASE_V1 = 'https://secure.fleetio.com/api/v1';
const FLEETIO_UPLOAD_ENDPOINT = 'https://lmuavc3zg4.execute-api.us-east-1.amazonaws.com/prod/uploads'; // official upload endpoint

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const API_TOKEN = requiredEnv('FLEETIO_API_TOKEN');        // keep in Vercel
const ACCOUNT_TOKEN = requiredEnv('FLEETIO_ACCOUNT_TOKEN'); // e.g. 80ce8e499c

// ---------- helpers ----------
const defaultHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `Token ${API_TOKEN}`,
  'Account-Token': ACCOUNT_TOKEN
};

function normalize(s) { return String(s || '').trim().toLowerCase(); }

function toIsoDate(dateLike) {
  // Produce YYYY-MM-DD (UTC)
  if (!dateLike) return new Date().toISOString().slice(0, 10);
  if (typeof dateLike === 'string') {
    // allow "mm/dd/yyyy"
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

function toIsoDateTime(dateLike) {
  // Full ISO-8601
  if (!dateLike) return new Date().toISOString();
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  return d.toISOString();
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

// Force absolute URL and ensure it has ?id=<inspectionId>
function ensureReportUrl(req, reportUrl, inspectionId) {
  const origin = deriveOrigin(req);
  let absolute = reportUrl || '';
  if (!/^https?:\/\//i.test(absolute)) {
    absolute = `${origin}${absolute.startsWith('/') ? '' : '/'}${absolute}`;
  }
  try {
    const u = new URL(absolute);
    if (!u.searchParams.has('id') && inspectionId) {
      u.searchParams.set('id', String(inspectionId));
    }
    return u.toString();
  } catch {
    // as a last resort, build from scratch
    const base = `${origin}/output.html`;
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}id=${encodeURIComponent(String(inspectionId || ''))}`;
  }
}

// ---------- Fleetio HTTP ----------
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

// ---------- PDF via your existing printer ----------
async function renderPdfBuffer(req, { reportUrl, filename, data, inspectionId }) {
  const urlForRender = ensureReportUrl(req, reportUrl, inspectionId);
  const origin = deriveOrigin(req);
  const printUrl = `${origin}/api/pdf/print`;
  const res = await fetch(printUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: urlForRender,                          // absolute, with ?id=
      filename: filename || 'schedule4.pdf',
      data: data || {}
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`[render_pdf] Printer failed: ${res.status} ${t}`);
    err.step = 'render_pdf'; err.status = res.status; err.details = t;
    throw err;
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- Upload to Fleetio-managed storage (policy/signature/path) ----------
async function uploadPdfToFleetio(pdfBuffer, filename) {
  // Step 1: get policy from v1
  // Per docs: POST /api/v1/uploads/policies → { policy, signature, path } then upload binary to the fixed endpoint. :contentReference[oaicite:2]{index=2}
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

  // Step 2: binary upload to Fleetio’s storage provider
  const url = new URL(FLEETIO_UPLOAD_ENDPOINT);
  url.searchParams.set('policy', policy);
  url.searchParams.set('signature', signature);
  url.searchParams.set('path', path);
  if (filename) url.searchParams.set('filename', filename);

  const up = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdfBuffer
  });
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    const err = new Error(`[upload_pdf] Binary upload failed: ${up.status} ${t}`);
    err.step = 'upload_pdf'; err.status = up.status; err.details = t;
    throw err;
  }

  const j = await up.json().catch(() => null);
  const fileUrl = j?.url; // carry forward as file_url
  if (!fileUrl) {
    const err = new Error('[upload_pdf] Upload response missing url');
    err.step = 'upload_pdf'; err.status = 500; err.details = JSON.stringify(j).slice(0, 500);
    throw err;
  }
  return fileUrl;
}

// ---------- Lookups (v1; per_page <= 100) ----------
async function listAllVehicles() {
  const all = [];
  const PER_PAGE = 100;

  // Cursor pagination first
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

  // Fallback to page/per_page (older tenants)
  if (all.length === 0) {
    let page = 1;
    for (let p = 0; p < 25; p++) {
      const qs = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
      const out = await fleetioV1(`/vehicles?${qs.toString()}`, {}, 'list_vehicles');
      const items = Array.isArray(out) ? out : (out?.data || out?.records || []);
      if (!items?.length) break;
      all.push(...items);
      if (items.length < PER_PAGE) break;
      page++;
    }
  }
  return all;
}

function vehicleLabel(v) {
  return v?.name || v?.vehicle_number || v?.external_id || v?.label || `Vehicle ${v?.id}`;
}

function bestVehicleMatch(vehicles, unitNumber) {
  const t = normalize(unitNumber);
  if (!t) return null;
  for (const v of vehicles) {
    const candidates = [
      v?.name, v?.vehicle_number, v?.external_id, v?.label,
      v?.identifier, v?.unit, v?.unit_number, v?.number
    ];
    if (candidates.some(c => normalize(c) === t)) return v;
  }
  for (const v of vehicles) {
    const lab = normalize(vehicleLabel(v));
    if (lab && lab.includes(t)) return v;
  }
  return null;
}

// Work Order Statuses (v1) :contentReference[oaicite:3]{index=3}
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

// Service Tasks (v1)
async function findOrCreateServiceTaskId(name) {
  const PER_PAGE = 100;
  let cursor = null;
  let found = null;

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

  const created = await fleetioV1('/service_tasks', {
    method: 'POST',
    body: JSON.stringify({ name })
  }, 'create_service_task');

  if (!created?.id) {
    const err = new Error('[create_service_task] Service Task creation failed');
    err.step = 'create_service_task'; err.status = 500;
    throw err;
  }
  return created.id;
}

// ---------- Handler ----------
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
      serviceTaskName
    } = req.body || {};

    if (!inspectionId) return res.status(400).json({ error: 'inspectionId is required' });
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    if (!reportUrl) return res.status(400).json({ error: 'reportUrl is required' });

    // Map Schedule 4 fields
    const inspectionDate = data.inspectionDate || data.dateInspected || data.date_inspected || null;
    const odometer = numOrNull(data.odometer ?? data.odometerStart ?? data.startOdometer);

    // 1) Resolve vehicle (v1)
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

    // 2) Resolve "Open" status (v1)
    const work_order_status_id = await getOpenStatusId();

    // 3) Build payload: issued_at/started_at = Date Inspected; meters mirror
    const issued_at = toIsoDateTime(inspectionDate || new Date());
    const started_at = issued_at;

    const woPayload = {
      vehicle_id: finalVehicleId,
      work_order_status_id,
      issued_at,
      started_at,
      ending_meter_same_as_start: odometer != null ? true : undefined, // :contentReference[oaicite:4]{index=4}
      ...(odometer != null
        ? {
            starting_meter_entry_attributes: {
              value: odometer,
              date: toIsoDate(inspectionDate || new Date()),
              meter_type: 'primary' // explicitly target odometer (primary). :contentReference[oaicite:5]{index=5}
            }
          }
        : {})
    };

    // 4) Create Work Order (v2)
    const createdWO = await fleetioV2('/work_orders', {
      method: 'POST',
      body: JSON.stringify(woPayload)
    }, 'create_work_order');

    const workOrderId = createdWO?.id;
    if (!workOrderId) {
      const err = new Error('[create_work_order] No id returned');
      err.step = 'create_work_order'; err.status = 500;
      throw err;
    }

    // 5) Render PDF (your existing printer) — ensure absolute URL w/ ?id=
    const pdfBuffer = await renderPdfBuffer(req, { reportUrl, filename, data, inspectionId });

    // 6) Upload to Fleetio storage & get public URL (policy/signature/path flow) :contentReference[oaicite:6]{index=6}
    const file_url = await uploadPdfToFleetio(pdfBuffer, filename);

    // 7) Attach document to Work Order (v2 PATCH with documents_attributes)
    await fleetioV2(`/work_orders/${workOrderId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        documents_attributes: [
          {
            name: filename,
            file_url
          }
        ]
      })
    }, 'attach_document');

    // 8) Ensure Service Task exists (v1), then add as Work Order line item (v2).
    const taskName = serviceTaskName || 'Schedule 4 Inspection (& EEPOC FMCSA 396.3)';
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

    // Fleetio UI URL (with account token + id) as you requested
    const work_order_url = `https://secure.fleetio.com/${ACCOUNT_TOKEN}/work_orders/${workOrderId}/edit`;

    return res.status(200).json({
      ok: true,
      work_order_id: workOrderId,
      work_order_url,
      attached_document_url: file_url
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
