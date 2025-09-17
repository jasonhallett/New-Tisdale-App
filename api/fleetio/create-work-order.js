// /api/fleetio/create-work-order.js
// Vercel/Next.js "pages/api" style function (Node runtime)
// Creates a Fleetio Work Order, attaches the inspection PDF, and adds a Service Task line item.
// Maps Schedule 4 fields: issued_at + started_at = "Date Inspected"; meters from "odometer".

export const config = { runtime: 'nodejs' };

const BASE_V2 = 'https://secure.fleetio.com/api/v2';
const BASE_V1 = 'https://secure.fleetio.com/api/v1';

function assertEnv(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}
const API_TOKEN = assertEnv('FLEETIO_API_TOKEN');
const ACCOUNT_TOKEN = assertEnv('FLEETIO_ACCOUNT_TOKEN');
const APP_BASE_URL = assertEnv('APP_BASE_URL');

// ---------- small utils ----------
const jsonHeaders = {
  'Content-Type': 'application/json',
  'Authorization': `Token ${API_TOKEN}`,
  'Account-Token': ACCOUNT_TOKEN
};

function toIsoDate(dateLike) {
  // Produces YYYY-MM-DD
  if (!dateLike) return new Date().toISOString().slice(0, 10);
  // handle "mm/dd/yyyy" or "yyyy-mm-dd"
  if (typeof dateLike === 'string') {
    const mdy = dateLike.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) {
      const [ , m, d, y ] = mdy;
      const dt = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00`);
      return dt.toISOString().slice(0, 10);
    }
  }
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function toIsoDateTime(dateLike) {
  // Full ISO timestamp
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

function normalize(s) { return String(s || '').trim().toLowerCase(); }

// ---------- Fleetio HTTP ----------
async function fleetioV2(path, init = {}) {
  const res = await fetch(`${BASE_V2}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), ...jsonHeaders }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fleetio V2 ${init.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

async function fleetioV1(path, init = {}) {
  const res = await fetch(`${BASE_V1}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), ...jsonHeaders }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Fleetio V1 ${init.method || 'GET'} ${path} failed: ${res.status} ${body}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ---------- PDF: use your existing /api/pdf/print ----------
async function renderPdfBuffer({ reportUrl, filename, data }) {
  const res = await fetch(`${APP_BASE_URL}/api/pdf/print`, {
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
    throw new Error(`PDF print failed: ${res.status} ${t}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

// ---------- Upload PDF to Fleetio-managed storage, return public file_url ----------
async function uploadPdfToFleetio({ pdfBuffer, filename }) {
  // Ask Fleetio for an upload policy
  // Many accounts return an S3-style policy: { upload_url, fields, asset_host, public_url }
  const policy = await fleetioV1('/uploads/policies', {
    method: 'POST',
    body: JSON.stringify({
      filename: filename || 'schedule4.pdf',
      file_content_type: 'application/pdf'
    })
  });

  // If it's the S3 multipart style (upload_url + fields), perform a multipart POST
  if (policy?.upload_url && policy?.fields) {
    const form = new FormData();
    Object.entries(policy.fields).forEach(([k, v]) => form.append(k, v));
    // 'file' must be the last field for some S3 configs
    form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), filename || 'schedule4.pdf');

    const s3Res = await fetch(policy.upload_url, { method: 'POST', body: form });
    if (!s3Res.ok) {
      const t = await s3Res.text().catch(() => '');
      throw new Error(`S3 upload failed: ${s3Res.status} ${t}`);
    }

    // Construct a public URL if not provided directly
    const key = policy.fields.key || policy.fields.Key;
    const fileUrl =
      policy.public_url ||
      (policy.asset_host && key ? `${policy.asset_host}/${key}` : null);

    if (!fileUrl) {
      throw new Error('Upload policy did not include a resolvable public URL');
    }
    return fileUrl;
  }

  // Some older policies may return { policy, signature, path, endpoint } with a direct binary POST.
  if (policy?.endpoint && policy?.policy && policy?.signature && policy?.path) {
    const url = new URL(policy.endpoint);
    url.searchParams.set('policy', policy.policy);
    url.searchParams.set('signature', policy.signature);
    url.searchParams.set('path', policy.path);
    if (filename) url.searchParams.set('filename', filename);

    const upRes = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBuffer
    });
    if (!upRes.ok) {
      const t = await upRes.text().catch(() => '');
      throw new Error(`Binary upload failed: ${upRes.status} ${t}`);
    }
    const j = await upRes.json().catch(() => null);
    const fileUrl = j?.url || j?.file_url || policy.public_url;
    if (!fileUrl) throw new Error('Upload response missing public url');
    return fileUrl;
  }

  throw new Error('Unrecognized upload policy shape from Fleetio');
}

// ---------- Lookups ----------
async function listAllVehicles() {
  // Simple page-based pagination
  let page = 1;
  const per_page = 200;
  const all = [];
  // Some tenants may cap pages; loop up to a safe bound
  for (let i = 0; i < 25; i++) {
    const qs = new URLSearchParams({ page: String(page), per_page: String(per_page) });
    const out = await fleetioV2(`/vehicles?${qs.toString()}`);
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
  const qs = new URLSearchParams({ per_page: '200' });
  const out = await fleetioV2(`/work_order_statuses?${qs.toString()}`);
  const items = Array.isArray(out?.data) ? out.data : (Array.isArray(out) ? out : []);
  const open = items.find(s => normalize(s?.name) === 'open') || items.find(s => s?.is_default);
  if (!open?.id) throw new Error('Could not resolve Work Order Status "Open"');
  return open.id;
}

async function findOrCreateServiceTaskId(name) {
  const per_page = 200;
  let page = 1;
  let found = null;

  while (!found && page < 20) {
    const qs = new URLSearchParams({ per_page: String(per_page), page: String(page) });
    const out = await fleetioV1(`/service_tasks?${qs.toString()}`);
    const items = Array.isArray(out?.data) ? out.data : (Array.isArray(out) ? out : []);
    found = items.find(t => normalize(t?.name) === normalize(name)) || null;
    if (items.length < per_page) break;
    page++;
  }

  if (found?.id) return found.id;

  const created = await fleetioV1('/service_tasks', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  if (!created?.id) throw new Error('Failed to create Service Task');
  return created.id;
}

// ---------- Main handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Expected body from your viewer:
    // {
    //   inspectionId, filename, reportUrl, data: { inspectionDate, odometer, ... },
    //   unitNumber, vehicleId?, serviceTaskName?
    // }
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

    // Pull values from your Schedule 4 data
    const inspectionDate =
      data.inspectionDate || data.dateInspected || data.date_inspected || null;_
