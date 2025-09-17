// /js/fleetio-integration.js
// Hooks the "Fleetio" button in pdf_viewer.html, grabs the *displayed* PDF bytes,
// and posts them (base64) to /api/fleetio/create-work-order

(function () {
  function $(sel) { return document.querySelector(sel); }

  function getQuery() {
    const u = new URL(window.location.href);
    return u.searchParams;
  }

  function guessFilename(unit, dateStr) {
    const date = dateStr ? new Date(dateStr) : new Date();
    const y = date.getFullYear();
    const m = String(date.getMonth()+1).padStart(2,'0');
    const d = String(date.getDate()).padStart(2,'0');
    const unitSafe = (unit || 'unit').toString().replace(/[^A-Za-z0-9._-]+/g, '-');
    return `Schedule4_${unitSafe}_${y}-${m}-${d}.pdf`;
  }

  async function findPdfSrc() {
    // Try explicit PDF elements first
    const iframe = document.querySelector('iframe[src$=".pdf"], iframe[type="application/pdf"], iframe.pdf, #pdfFrame, .pdf-iframe');
    const embed = document.querySelector('embed[type="application/pdf"], embed[src$=".pdf"]');
    const objectEl = document.querySelector('object[type="application/pdf"], object[data$=".pdf"]');

    const candidates = [];
    if (iframe && iframe.src) candidates.push(iframe.src);
    if (embed && embed.src) candidates.push(embed.src);
    if (objectEl && objectEl.data) candidates.push(objectEl.data);

    // Fallback to ?src= param
    const q = getQuery();
    const srcParam = q.get('src');
    if (srcParam) candidates.push(srcParam);

    // Pick the first that looks like a PDF/data/blob URL
    for (const src of candidates) {
      if (!src) continue;
      if (/^blob:|^data:application\/pdf|\.pdf(\?|$)|^https?:/i.test(src)) return src;
    }
    return null;
  }

  async function fetchPdfBase64(src) {
    if (!src) throw new Error('No PDF src');
    if (src.startsWith('data:application/pdf')) {
      return src; // already data URL
    }
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`Failed to fetch PDF: ${resp.status}`);
    const ab = await resp.arrayBuffer();
    // Convert to base64
    let binary = '';
    const bytes = new Uint8Array(ab);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const b64 = btoa(binary);
    return `data:application/pdf;base64,${b64}`;
  }

  function getContext() {
    const q = getQuery();
    const ctx = {
      inspectionId: q.get('id') || null,
      inspectionDate: q.get('date') || q.get('inspected_at') || q.get('inspected') || null,
      unitNumber: q.get('unit') || q.get('vehicle') || q.get('unit_number') || null,
      odometer: q.get('odo') || q.get('odometer') || null
    };

    // Attempt pulls from a global payload if present
    if (window.TBL && typeof window.TBL === 'object') {
      ctx.inspectionId = ctx.inspectionId || window.TBL.inspectionId || null;
      ctx.inspectionDate = ctx.inspectionDate || window.TBL.inspectionDate || null;
      ctx.unitNumber = ctx.unitNumber || window.TBL.unitNumber || null;
      ctx.odometer = ctx.odometer || window.TBL.odometer || null;
    }
    return ctx;
  }

  async function postJson(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const ct = r.headers.get('content-type') || '';
    const json = ct.includes('application/json') ? await r.json() : { ok: r.ok, text: await r.text() };
    if (!r.ok) {
      const err = new Error(json?.error || `HTTP ${r.status}`);
      err.step = json?.step;
      err.details = json?.details;
      err.payload = json;
      throw err;
    }
    return json;
  }

  function ensure(val, label) {
    if (val == null || val === '') throw new Error(`${label} is required`);
    return val;
  }

  function showVehiclePicker(choices) {
    return new Promise((resolve, reject) => {
      // Simple modal
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:#111;border:1px solid #333;padding:16px;border-radius:10px;min-width:320px;color:#fff;font:14px system-ui';
      modal.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px">Select Fleetio Vehicle</div>
        <select id="fleetioVehicleSelect" style="width:100%;background:#0b0b0c;border:1px solid #333;color:#fff;padding:8px;border-radius:8px;margin-bottom:12px">
          ${choices.map(c=>`<option value="${c.id}">${c.label}</option>`).join('')}
        </select>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="fleetioCancel" style="padding:8px 12px;background:#333;border-radius:8px">Cancel</button>
          <button id="fleetioOK" style="padding:8px 12px;background:#22c55e;color:#000;border-radius:8px">Use Vehicle</button>
        </div>
      `;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      modal.querySelector('#fleetioCancel').onclick = () => { document.body.removeChild(overlay); reject(new Error('cancelled')); };
      modal.querySelector('#fleetioOK').onclick = () => {
        const sel = modal.querySelector('#fleetioVehicleSelect');
        const id = sel.value;
        document.body.removeChild(overlay);
        resolve(id);
      };
    });
  }

  async function onFleetioClick() {
    try {
      const btn = this;
      btn.disabled = true;

      const ctx = getContext();
      const inspectionId = ensure(ctx.inspectionId, 'Inspection Id');
      const unitNumber = ctx.unitNumber || prompt('Unit # not found on page. Enter the Fleet Unit #:');
      const inspectionDate = ctx.inspectionDate || new Date().toISOString().slice(0,10);
      const odometer = ctx.odometer || '';

      const src = await findPdfSrc();
      if (!src) throw new Error('Could not locate the rendered PDF in this viewer.');
      const pdfDataUrl = await fetchPdfBase64(src);
      const filename = guessFilename(unitNumber, inspectionDate);

      const payload = {
        inspectionId,
        unitNumber,
        data: { inspectionDate, odometer },
        filename,
        pdfBase64: pdfDataUrl
      };

      const res = await postJson('/api/fleetio/create-work-order', payload);
      if (res?.ok) {
        window.open(res.work_order_url, '_blank');
        alert('Fleetio Work Order created and PDF attached.');
        return;
      }

      // Handle vehicle-not-found flow
      if (res?.code === 'vehicle_not_found') {
        const vehicleId = await showVehiclePicker(res.choices || []);
        const res2 = await postJson('/api/fleetio/create-work-order', { ...payload, vehicleId });
        window.open(res2.work_order_url, '_blank');
        alert('Fleetio Work Order created and PDF attached.');
        return;
      }

      alert('Fleetio error: ' + JSON.stringify(res || {}, null, 2));
    } catch (err) {
      console.error(err);
      alert('Fleetio Error: ' + (err?.message || String(err)));
    } finally {
      this.disabled = false;
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('#btnFleetio, [data-action="fleetio"], .btn-fleetio');
    if (!btn) return;
    btn.addEventListener('click', onFleetioClick);
  });
})();