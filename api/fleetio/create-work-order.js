import { NextResponse } from 'next/server'; // If using Next.js 13+. If on pages/api, swap to default req,res handler.
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';

export const config = { runtime: 'nodejs' };

// ---------- env ----------
const FLEETIO_BASE_URL = process.env.FLEETIO_BASE_URL || 'https://secure.fleetio.com/api';
const FLEETIO_API_TOKEN = process.env.FLEETIO_API_TOKEN; // "Token xxxxx"
const FLEETIO_ACCOUNT_TOKEN = process.env.FLEETIO_ACCOUNT_TOKEN; // e.g. 80ce8e499c
const APP_BASE_URL = process.env.APP_BASE_URL; // e.g. https://your-app.vercel.app

if (!FLEETIO_API_TOKEN) console.warn('Missing FLEETIO_API_TOKEN');
if (!FLEETIO_ACCOUNT_TOKEN) console.warn('Missing FLEETIO_ACCOUNT_TOKEN');
if (!APP_BASE_URL) console.warn('Missing APP_BASE_URL (used to call /api/pdf/print)');

// ---------- tiny fetch wrapper ----------
async function fleetio(path, init = {}) {
  const headers = {
    'Authorization': `Token ${FLEETIO_API_TOKEN}`,
    'Account-Token': FLEETIO_ACCOUNT_TOKEN,
    ...(init.headers || {}),
  };
  const res = await fetch(`${FLEETIO_BASE_URL}${path}`, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Fleetio ${init.method || 'GET'} ${path} failed: ${res.status} ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

// ---------- PDF generation via your existing /api/pdf/print ----------
async function renderPdfBuffer({ reportUrl, filename, data }) {
  // call your own printer endpoint so we don't duplicate logic
  const res = await fetch(`${APP_BASE_URL}/api/pdf/print`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: reportUrl, filename: filename || 'schedule4.pdf', data: data || {} }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Printer failed: ${res.status} ${t}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---------- Upload PDF into Fleetio-managed storage (policy + upload) ----------
async function getUploadPolicy() {
  return fleetio('/v1/uploads/policies', { method: 'POST' });
}
async function uploadToFleetioStorage({ pdfBuffer, filename }) {
  const { policy, signature, path } = await getUploadPolicy();
  // Fleetio docs show this fixed endpoint for uploads
  const endpoint = 'https://lmuavc3zg4.execute-api.us-east-1.amazonaws.com/prod/uploads';
  const url = new URL(endpoint);
  url.searchParams.set('signature', signature);
  url.searchParams.set('policy', policy);
  url.searchParams.set('path', path);
  if (filename) url.searchParams.set('filename', filename);

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: pdfBuffer
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Upload failed: ${res.status} ${t}`);
  }
  const json = await res.json();
  if (!json?.url) throw new Error('Upload response missing url');
  return json.url;
}

// ---------- Helper lookups ----------
async function listAllVehicles() {
  // Newer API uses keyset pagination with start_cursor
  let cursor = undefined;
  const results = [];
  do {
    const qp = new URLSearchParams();
    if (cursor) qp.set('start_cursor', cursor);
    qp.set('per_page', '200');
    const page = await fleetio(`/v1/vehicles?${qp.toString()}`);
    const items = Array.isArray(page?.data) ? page.data : Array.isArray(page) ? page : [];
    const next = page?.next_cursor || page?.start_cursor; // be liberal
    results.push(...items);
    cursor = page?.next_cursor || null;
  } while (cursor);
  return results;
}

function normalize(s) { return String(s || '').trim().toLowerCase(); }

function vehicleLabel(v) {
  return v?.name || v?.label || v?.vehicle_number || v?.id;
}

function bestVehicleMatch(vehicles, unitNumber) {
  const target = normalize(unitNumber);
  if (!target) return null;
  // try exact matches on common fields
  for (const v of vehicles) {
    const fields = [
      v?.name, v?.label, v?.vehicle_number, v?.external_id, v?.identifier, v?.unit, v?.unit_number, v?.number
    ];
    if (fields.some(f => normalize(f) === target)) return v;
  }
  // fallback: contains
  for (const v of vehicles) {
    const f = normalize(vehicleLabel(v));
    if (f && f.includes(target)) return v;
  }
  return null;
}

async function getOpenStatusId() {
  const statuses = await fleetio('/work_order_statuses'); // versionless doc page resolves to latest
  const items = Array.isArray(statuses?.data) ? statuses.data : Array.isArray(statuses) ? statuses : [];
  const open = items.find(s => normalize(s?.name) === 'open') || items.find(s => s?.is_default);
  if (!open?.id) throw new Error('Could not resolve Work Order Status "Open"');
  return open.id;
}

async function findOrCreateServiceTaskId(name) {
  const qp = new URLSearchParams();
  qp.set('per_page', '200');
  // try filter by name if supported; otherwise search client-side
  const page = await fleetio(`/v1/service_tasks?${qp.toString()}`);
  const items = Array.isArray(page?.data) ? page.data : Array.isArray(page) ? page : [];
  const hit = items.find(t => normalize(t?.name) === normalize(name));
  if (hit?.id) return hit.id;

  // create it
  const created = await fleetio('/v1/service_tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (!created?.id) throw new Error('Service Task creation failed');
  return created.id;
}

// ---------- main handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { inspectionId, unitNumber, data, filename, reportUrl, vehicleId, serviceTaskName } = req.body || {};

    if (!inspectionId) return res.status(400).json({ error: 'inspectionId is required' });
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    if (!reportUrl) return res.status(400).json({ error: 'reportUrl is required' });

    // Step 1: resolve vehicle id if not provided
    let finalVehicleId = vehicleId;
    let allVehicles = null;
    if (!finalVehicleId) {
      allVehicles = await listAllVehicles();
      const match = bestVehicleMatch(allVehicles, unitNumber);
      if (match) finalVehicleId = match.id;
    }

    if (!finalVehicleId) {
      // Return choices for modal
      if (!allVehicles) allVehicles = await listAllVehicles();
      const choices = (allVehicles || []).map(v => ({
        id: v.id, label: vehicleLabel(v)
      }));
      return res.status(404).json({
        code: 'vehicle_not_found',
        message: `Could not find a Fleetio vehicle matching Unit "${unitNumber}". Pick one below.`,
        choices
      });
    }

    // Step 2: create a work order in "Open"
    const work_order_status_id = await getOpenStatusId();
    const issued_at = new Date().toISOString().slice(0, 10); // date only

    const created = await fleetio('/v2/work_orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vehicle_id: finalVehicleId,
        issued_at,
        work_order_status_id
      })
    });

    const workOrderId = created?.id;
    if (!workOrderId) throw new Error('Work Order creation returned no id');

    // Step 3: render PDF and upload to Fleetio storage, then attach to WO
    const pdfBuffer = await renderPdfBuffer({ reportUrl, filename, data });
    const file_url = await uploadToFleetioStorage({ pdfBuffer, filename });

    await fleetio(`/v2/work_orders/${workOrderId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        documents_attributes: [
          { name: filename, file_url }
        ]
      })
    });

    // Step 4: add a Work Order line item for the specified Service Task
    const taskName = serviceTaskName || 'Schedule 4 Inspection (& EEPOC FMCSA 396.3)';
    const serviceTaskId = await findOrCreateServiceTaskId(taskName);
    await fleetio(`/v2/work_orders/${workOrderId}/work_order_line_items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'WorkOrderServiceTaskLineItem',
        item_type: 'ServiceTask',
        item_id: serviceTaskId,
        description: taskName
      })
    });

    // Compose a friendly response. Many Fleetio resources include a web URL field; if not, construct one.
    const work_order_url = created?.web_url || `https://secure.fleetio.com/work_orders/${workOrderId}`;

    res.status(200).json({
      ok: true,
      work_order: created,
      work_order_url
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
