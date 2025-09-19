/* eslint-disable no-console */

/**
 * Fleetio work-order creation + DB update
 * Runs on pdf_viewer.html. Expects:
 *   window.schedule4InspectionId (string)
 *   window.schedule4Meta = { unit, odometer, date, filename }
 *
 * Server endpoints assumed:
 *   POST  /api/fleetio/create-work-order
 *         Body: {
 *           inspectionId, unit, date, filename,
 *           pdfBase64  // data URL or raw base64 (no prefix)
 *         }
 *         Returns JSON with at least:
 *           {
 *             ok: true,
 *             work_order_number,   // or workOrderNumber
 *             work_order_id,       // or id / workOrderId / fleetio_work_order_id
 *             pdf_url,             // or pdfUrl
 *             file_name            // or fileName
 *           }
 *
 *   PATCH /api/inspections
 *         Body: {
 *           id,
 *           internal_work_order_number,
 *           fleetio_work_order_id,
 *           fleetio_file_name,
 *           fleetio_pdf_url
 *         }
 */

(function () {
  const btn = document.getElementById('btnFleetio');
  if (!btn) return;

  function qs(sel, root = document) { return root.querySelector(sel); }

  function setBusy(el, busy) {
    if (!el) return;
    el.disabled = !!busy;
    el.dataset.busy = busy ? '1' : '0';
    if (busy) {
      el.dataset.__oldText = el.textContent;
      el.textContent = 'Working…';
    } else if (el.dataset.__oldText) {
      el.textContent = el.dataset.__oldText;
      delete el.dataset.__oldText;
    }
  }

  function toast(msg, type = 'info') {
    try {
      // Minimal inline toast
      const t = document.createElement('div');
      t.textContent = msg;
      t.className =
        'fixed bottom-4 left-1/2 -translate-x-1/2 z-[1000] px-3 py-2 rounded text-sm ' +
        (type === 'error'
          ? 'bg-red-600 text-white'
          : type === 'success'
          ? 'bg-emerald-600 text-white'
          : 'bg-white/10 text-white border border-white/10');
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
    } catch (_) {
      alert(msg);
    }
  }

  function getViewerContext() {
    const id = (window.schedule4InspectionId || '').trim();
    const meta = window.schedule4Meta || {};
    const filename =
      (meta.filename && String(meta.filename).trim()) ||
      'Schedule-4_Inspection.pdf';
    // Pull iframe src
    const iframe = qs('#pdf');
    const src = iframe ? iframe.getAttribute('src') || '' : '';
    return {
      id,
      meta: {
        unit: meta.unit || '',
        odometer: meta.odometer || '',
        date: meta.date || '',
        filename
      },
      src
    };
  }

  async function blobToBase64(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    // Convert to base64 without MIME prefix
    let binary = '';
    const bytes = new Uint8Array(arrayBuffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function getPdfAsBase64(src) {
    if (!src) throw new Error('No PDF source available.');
    // Prefer the in-memory blob if present (saved by viewer)
    try {
      const idKey =
        window.schedule4InspectionId ||
        new URLSearchParams(location.search).get('id') ||
        'default';
      const cached = window.__getPdfBlob ? window.__getPdfBlob(idKey) : null;
      if (cached) return await blobToBase64(cached);
    } catch (_) {}

    // Fallback: fetch the src (blob: or http/https)
    const res = await fetch(src, { credentials: 'omit' });
    if (!res.ok) throw new Error(`Failed to fetch PDF (${res.status})`);
    const blob = await res.blob();
    return await blobToBase64(blob);
  }

  function pick(obj, keys, fallbackKeys = []) {
    for (const k of keys) if (obj && obj[k] != null) return obj[k];
    for (const k of fallbackKeys) if (obj && obj[k] != null) return obj[k];
    return undefined;
  }

  async function createFleetioWorkOrder(payload) {
    const res = await fetch('/api/fleetio/create-work-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || data.ok === false) {
      const msg =
        (data && (data.error || data.message)) ||
        `Fleetio create failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  async function patchInspection(updateBody) {
    // Primary: PATCH /api/inspections
    let res = await fetch('/api/inspections', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBody)
    });

    if (res.status === 404) {
      // Fallback: POST /api/inspections/update (if your API uses this path)
      res = await fetch('/api/inspections/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateBody)
      });
    }

    let data;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || (data && data.ok === false)) {
      const msg =
        (data && (data.error || data.message)) ||
        `DB update failed (${res.status})`;
      throw new Error(msg);
    }
    return data;
  }

  async function handleFleetioFlow() {
    const { id, meta, src } = getViewerContext();
    if (!id) throw new Error('Missing Schedule-4 record id on viewer page.');

    // Build the payload for Fleetio WO creation
    const pdfBase64 = await getPdfAsBase64(src);
    const payload = {
      inspectionId: id,
      unit: meta.unit,
      date: meta.date,
      filename: meta.filename,
      pdfBase64 // raw base64; server can prepend data URL if needed
    };

    // 1) Create Fleetio Work Order
    const wo = await createFleetioWorkOrder(payload);

    // Normalize fields from response
    const workOrderNumber = pick(
      wo,
      ['work_order_number', 'workOrderNumber', 'number']
    );
    const workOrderId = pick(
      wo,
      ['work_order_id', 'workOrderId', 'id', 'fleetio_work_order_id']
    );
    const pdfUrl = pick(wo, ['pdf_url', 'pdfUrl']);
    const fileName = pick(wo, ['file_name', 'fileName'], ['filename']) || meta.filename;

    // 2) Update our Schedule-4 database row (snake_case)
    const updateBody = {
      id,
      internal_work_order_number: String(workOrderNumber || '').trim(),
      fleetio_work_order_id: String(workOrderId || '').trim(),
      fleetio_file_name: String(fileName || '').trim(),
      fleetio_pdf_url: String(pdfUrl || '').trim()
    };

    await patchInspection(updateBody);

    return {
      workOrderNumber,
      workOrderId,
      pdfUrl,
      fileName
    };
  }

  btn.addEventListener('click', async () => {
    try {
      setBusy(btn, true);
      const r = await handleFleetioFlow();
      const summary =
        `Fleetio WO created (#${r.workOrderNumber || r.workOrderId || 'unknown'}) ` +
        `and DB updated.`;
      toast(summary, 'success');
    } catch (err) {
      console.error('Fleetio export failed:', err);
      toast(`Fleetio export failed: ${err?.message || err}`, 'error');
    } finally {
      setBusy(btn, false);
    }
  });
})();
