// /api/fleetio/create-work-order.js
// Creates a Fleetio Work Order in "Open", maps Date/Odometer, renders & attaches the PDF,
// and adds the "Schedule 4 Inspection (& EEPOC FMCSA 396.3)" Service Task as a line item.

export const config = { runtime: 'nodejs' };

const BASE_V2 = 'https://secure.fleetio.com/api/v2';
const BASE_V1 = 'https://secure.fleetio.com/api/v1';

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const API_TOKEN = requiredEnv('FLEETIO_API_TOKEN');       // keep in Vercel
const ACCOUNT_TOKEN = requiredEnv('FLEETIO_ACCOUNT_TOKEN'); // your 80ce8e499c (put in Vercel)

// ---------- helpers ----------
const defaultHeaders = {
  'Accept': 'application/json',
  'Content-Type': 'application/json',
  'Authorization': `Token ${API_TOKEN}`,
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
  // Use request headers instead of env so we don't need APP_BASE_URL
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers['host'];
  return `${proto}://${host}`;
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
async function renderPdfBuffer(req, { reportUrl, filename, data }) {
  const origin = deriveOrigin(req);
  const url = `${origin}/api/pdf/print`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: reportUrl,
      filename: filename || 'schedule4.pdf',
      data: data || {}
    })
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`[renderPdf] Printer failed: ${res.status} ${t}`);
    err.step = 'render_pdf'; err.status = res.status; err.details = t;
    throw err;
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- Upload to Fleetio-managed storage, return public file_url ----------
async function uploadPdfToFleetio(pdfBuffer, filename) {
  // Step 1: obtain policy (v1)
  // Docs: Attaching Documents & Images guide. :contentReference[oaicite:3]{index=3}
  const policy = await fleetioV1('/uploads/policies', {
    method: 'POST',
    body: JSON.stringify({
      filename: filename || 'schedule4.pdf',
      file_content_type: 'application/pdf'
    })
  }, 'get_upload_policy');

  // Common policy shape: upload_url + fields (S3 POST)
  if (policy?.upload_url && policy?.fields) {
    const form = new FormData();
    Object.entries(policy.fields).forEach(([k, v]) => form.append(k, v));
    form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename || 'schedule4.pdf');

    const up = await fetch(policy.upload_url, { method: 'POST', body: form });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      const err = new Error(`[upload_pdf] S3 upload failed: ${up.status} ${t}`);
      err.step = 'upload_pdf'; err.status = up.status; err.details = t;
      throw err;
    }

    const key = policy.fields.key || policy.fields.Key;
    const fileUrl = policy.public_url || (policy.asset_host && key ? `${policy.asset_host}/${key}` : null);
    if (!fileUrl) {
      const err = new Error('[upload_pdf] Upload policy missing public_url');
      err.step = 'upload_pdf'; err.status = 500;
      throw err;
    }
    return fileUrl;
  }

  // Older policy shape: endpoint/policy/signature/path
  if (policy?.endpoint && policy?.policy && policy?.signature && policy?.path) {
    const url = new URL(policy.endpoint);
    url.searchParams.set('policy', policy.policy);
    url.searchParams.set('signature', policy.signature);
    url.searchParams.set('path', policy.path);
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
    const fileUrl = j?.url || j?.file_url || policy.public_url;
    if (!fileUrl) {
      const err = new Error('[upload_pdf] Upload response missing public url');
      err.step = 'upload_pdf'; err.status = 500;
      throw err;
    }
    return fileUrl;
  }

  const err = new Error('[upload_pdf] Unrecognized upload policy shape');
  err.step = 'upload_pdf'; err.status = 500;
  throw err;
}

// ---------- Lookups ----------
async function listAllVehicles() {
  // v2 vehicles
  let page = 1;
  const per_page = 200;
  const all = [];
  for (let i = 0; i < 25; i++) {
    const qs = new URLSearchParams({ page: String(page), per_page: String(per_page) });
    const out = await fleetioV2(`/vehicles?${qs.toString()}`, {}, 'list_vehicles');
    const items = Array.isArray(out?.data) ? out.data : (Array.isArray(out) ? out : []);
    if (!items.length) break;
    all.push(...items);
    if (items.length < per_page) break;
    page++;
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

async function getOpenStatusId() {
  // Work Order Statuses (v2) :contentReference[oaicite:4]{index=4}
  const qs = new URLSearchParams({ per_page: '200' });
  const out = await fleetioV2(`/work_order_statuses?${qs.toString()}`, {}, 'get_open_status');
  const items = Array.isArray(out?.data) ? out.data : (Array.isArray(out) ? out : []);
  const open = items.find(s => normalize(s?.name) === 'open') || items.find(s => s?.is_default);
  if (!open?.id) {
    const err = new Error('[get_open_status] Could not resolve "Open" status');
    err.step = 'get_open_status'; err.status = 400;
    throw err;
  }
  return open.id;
}

async function findOrCreateServiceTaskId(name) {
  // Service Tasks are under v1 today. :contentReference[oaicite:5]{index=5}
  const per_page = 200;
  let page = 1;
  let found = null;

  while (!found && page < 20) {
    const qs = new URLSearchParams({ per_page: String(per_page), page: String(page) });
    const out = await fleetioV1(`/service_tasks?${qs.toString()}`, {}, 'list_service_tasks');
    const items = Array.isArray(out?.data) ? out.data : (Array.isArray(out) ? out : []);
    found = items.find(t => normalize(t?.name) === normalize(name)) || null;
    if (items.length < per_page) break;
    page++;
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

    // 3) Build payload: issued_at/started_at = Date Inspected; meters mirror
    const issued_at = toIsoDateTime(inspectionDate || new Date());
    const started_at = issued_at;

    const woPayload = {
      vehicle_id: finalVehicleId,
      work_order_status_id,
      issued_at,
      started_at,
      ending_meter_same_as_start: odometer != null ? true : undefined,
      ...(odometer != null
        ? {
            starting_meter_entry_attributes: {
              value: odometer,
              date: toIsoDate(inspectionDate || new Date())
              // meter_type: 'primary' // uncomment if your account requires it
            }
          }
        : {})
    };

    // 4) Create Work Order (v2)  :contentReference[oaicite:6]{index=6}
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

    // 5) Render PDF (your existing printer)
    const pdfBuffer = await renderPdfBuffer(req, { reportUrl, filename, data });

    // 6) Upload to Fleetio storage & get public URL
    const file_url = await uploadPdfToFleetio(pdfBuffer, filename);

    // 7) Attach document to Work Order (v2 PATCH with documents_attributes). :contentReference[oaicite:7]{index=7}
    await fleetioV2(`/work_orders/${workOrderId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        documents_attributes: [
          {
            name: filename,
            file_url,
            file_mime_type: 'application/pdf',
            file_name: filename
          }
        ]
      })
    }, 'attach_document');

    // 8) Ensure Service Task exists, then add as Work Order line item (v2). :contentReference[oaicite:8]{index=8}
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

    const work_order_url =
      createdWO?.web_url || `https://secure.fleetio.com/work_orders/${workOrderId}`;

    return res.status(200).json({
      ok: true,
      work_order_id: workOrderId,
      work_order_url,
      attached_document_url: file_url
    });

  } catch (err) {
    // Structured error so your viewer can show exactly which step failed
    console.error('Fleetio WO Error:', {
      step: err.step || 'unknown',
      status: err.status || 500,
      message: err.message,
      details: err.details?.slice?.(0, 1000) // truncate
    });
    return res.status(err.status || 500).json({
      error: err.message,
      step: err.step || 'unknown',
      details: err.details || undefined
    });
  }
}
