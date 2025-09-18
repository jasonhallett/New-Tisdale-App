// /js/fleetio-integration.js
// Minimal, robust client for creating the Fleetio WO:
// - Always extracts the PDF bytes from PDF.js (base64) to avoid blob: fetch failures
// - Sends unitNumber only if present; otherwise stops early with a friendly alert (no surprise 404 picker)
// - Ensures only one click handler runs (removes inline onclick if present)

(function () {
  function $(sel) { return document.querySelector(sel); }
  function getQuery() { try { return new URL(window.location.href).searchParams; } catch { return new URLSearchParams(); } }
  function parseNumber(n) { if (n==null) return null; const s=String(n).replace(/,/g,'').trim(); if(!s) return null; const x=Number(s); return Number.isFinite(x)?x:null; }

  function uiAlert(msg) { try { alert(msg); } catch {} }

  async function postJson(url, body) {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const ct = r.headers.get('content-type')||''; const json = ct.includes('application/json')? await r.json():null;
    if (!r.ok) {
      if (r.status===404 && json?.code==='vehicle_not_found') return json; // allow caller to handle picker
      throw new Error(json?.error || `HTTP ${r.status}`);
    }
    return json;
  }

  function getContext() {
    const q = getQuery();
    let ctx = {
      inspectionId: q.get('id') || null,
      inspectionDate: q.get('date') || q.get('inspected_at') || q.get('inspected') || null,
      unitNumber: q.get('unit') || q.get('vehicle') || q.get('unit_number') || null,
      odometer: parseNumber(q.get('odo') || q.get('odometer'))
    };
    try {
      const raw = sessionStorage.getItem('schedule4Data');
      if (raw) {
        const d = JSON.parse(raw);
        ctx.inspectionId   = ctx.inspectionId   || d.id || d.inspectionId || d.InspectionId || null;
        ctx.inspectionDate = ctx.inspectionDate || d.inspectionDate || d.date || d.dateInspected || null;
        ctx.unitNumber     = ctx.unitNumber     || d.unitNumber || d.unit || d.vehicle || d.unit_number || null;
        ctx.odometer       = (ctx.odometer ?? parseNumber(d.odometer ?? d.startOdometer ?? d.odo ?? d.mileage));
      }
    } catch {}
    if (window.TBL && typeof window.TBL === 'object') {
      ctx.inspectionId   = ctx.inspectionId   || window.TBL.inspectionId || null;
      ctx.inspectionDate = ctx.inspectionDate || window.TBL.inspectionDate || null;
      ctx.unitNumber     = ctx.unitNumber     || window.TBL.unitNumber || null;
      ctx.odometer       = ctx.odometer ?? parseNumber(window.TBL.odometer);
    }
    return ctx;
  }

  function bytesToBase64(u8) {
    let i = 0, out = '', CH = 0x8000;
    for (; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(out);
  }

  async function getPdfBase64FromViewer() {
    // Prefer the current window's PDF.js (pdf_viewer.html typically hosts it)
    try {
      const app = window.PDFViewerApplication;
      if (app && app.pdfDocument && typeof app.pdfDocument.getData === 'function') {
        const data = await app.pdfDocument.getData(); // Uint8Array
        return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(data));
      }
    } catch {}

    // If for some reason the viewer is inside an iframe on this page, try there (same-origin only)
    try {
      const frame = document.getElementById('pdfFrame') || document.querySelector('iframe');
      if (frame && frame.contentWindow) {
        const app2 = frame.contentWindow.PDFViewerApplication;
        if (app2 && app2.pdfDocument && typeof app2.pdfDocument.getData === 'function') {
          const data2 = await app2.pdfDocument.getData();
          return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(data2));
        }
      }
    } catch {}
    return null; // we will not fall back to blob: urls; they’re unreliable here
  }

  async function onFleetioClick(e) {
    e.preventDefault();
    const btn = this;

    // Ensure single handler (remove any inline)
    btn.onclick = null; btn.removeAttribute('onclick');
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1'; btn.disabled = true;

    try {
      const ctx = getContext();

      if (!ctx.inspectionId) {
        uiAlert('Missing Inspection ID. Please reopen this inspection from the list and try again.');
        return;
      }
      if (!ctx.unitNumber) {
        uiAlert('Missing Unit #. Please ensure the inspection has a Unit # before sending to Fleetio.');
        return;
      }

      // Always pull exact bytes from PDF.js (avoid blob: fetches)
      const pdfBase64 = await getPdfBase64FromViewer();
      if (!pdfBase64) {
        uiAlert('Unable to read the open PDF from the viewer. Please ensure this page is the PDF viewer (PDF.js) and try again.');
        return;
      }

      const safeUnit = (ctx.unitNumber || 'Unit').toString().replace(/[^\w\-]+/g, '_');
      const dateStr = ctx.inspectionDate || new Date().toISOString().slice(0,10);
      const filename = `Schedule-4_Inspection_${safeUnit}_${dateStr}.pdf`;

      const payload = {
        inspectionId: ctx.inspectionId,
        unitNumber: ctx.unitNumber,
        data: { inspectionDate: ctx.inspectionDate, odometer: ctx.odometer },
        filename,
        pdfBase64 // <- we send base64 only; no pdfUrl to avoid blob issues
      };

      let res = await postJson('/api/fleetio/create-work-order', payload);

      // If the server explicitly says it cannot find the vehicle, show picker
      if (res?.code === 'vehicle_not_found') {
        const id = await new Promise((resolve, reject) => {
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
          const modal = document.createElement('div');
          modal.style.cssText = 'background:#111;border:1px solid #333;padding:16px;border-radius:10px;min-width:320px;color:#fff;font:14px system-ui';
          modal.innerHTML = `
            <div style="font-weight:600;margin-bottom:8px">Select Fleetio Vehicle</div>
            <select id="fleetioVehicleSelect" style="width:100%;background:#0b0b0c;border:1px solid #333;color:#fff;padding:8px;border-radius:8px;margin-bottom:12px">
              ${(res.choices || []).map(c=>`<option value="${c.id}">${c.label}</option>`).join('')}
            </select>
            <div style="display:flex;gap:8px;justify-content:flex-end">
              <button id="fleetioCancel" style="padding:8px 12px;background:#333;border-radius:8px">Cancel</button>
              <button id="fleetioOK" style="padding:8px 12px;background:#22c55e;color:#000;border-radius:8px">Use Vehicle</button>
            </div>`;
          overlay.appendChild(modal); document.body.appendChild(overlay);
          modal.querySelector('#fleetioCancel').onclick = () => { document.body.removeChild(overlay); reject(new Error('cancelled')); };
          modal.querySelector('#fleetioOK').onclick = () => {
            const sel = modal.querySelector('#fleetioVehicleSelect'); const id = sel.value;
            document.body.removeChild(overlay); resolve(id);
          };
        });

        res = await postJson('/api/fleetio/create-work-order', { ...payload, vehicleId: id });
      }

      if (res?.ok) {
        window.open(res.work_order_url, '_blank');
        uiAlert('Fleetio Work Order created and PDF attached.');
        return;
      }

      uiAlert('Fleetio error: ' + JSON.stringify(res || {}, null, 2));
    } catch (err) {
      if (err.message !== 'cancelled') {
        console.error(err);
        uiAlert('Fleetio Error: ' + (err?.message || String(err)));
      }
    } finally {
      btn.disabled = false; btn.dataset.busy = '0';
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('#btnFleetio, [data-action="fleetio"], .btn-fleetio');
    if (!btn) return;
    // remove any legacy inline handler BEFORE adding ours (de-dupe)
    btn.onclick = null; btn.removeAttribute('onclick');
    btn.addEventListener('click', onFleetioClick, { once: false });
  });
})();
