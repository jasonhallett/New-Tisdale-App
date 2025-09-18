// /js/fleetio-integration.js
// Minimal, robust client for creating a Fleetio WO:
//
// - If Unit # is missing, prompt ONCE for it before posting
// - Always tries to pull PDF bytes from any PDF.js viewer (window OR any iframe)
//   with short retries (no dependence on fragile blob: URLs)
// - Ensures only one click handler runs (removes inline onclick if present)
// - Posts exactly once with pdfBase64 (no server-side re-render)
//
// Assumes your server route is /api/fleetio/create-work-order

(function () {
  function $(sel) { return document.querySelector(sel); }
  function getQuery() { try { return new URL(window.location.href).searchParams; } catch { return new URLSearchParams(); } }
  function parseNumber(n) { if (n==null) return null; const s=String(n).replace(/,/g,'').trim(); if(!s) return null; const x=Number(s); return Number.isFinite(x)?x:null; }
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  function uiAlert(msg) { try { alert(msg); } catch {} }

  async function postJson(url, body) {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const ct = r.headers.get('content-type')||''; const json = ct.includes('application/json')? await r.json():null;
    if (!r.ok) {
      if (r.status===404 && json?.code==='vehicle_not_found') return json; // let caller show vehicle picker
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

  async function getPdfFromViewerOnce(win) {
    try {
      const app = win.PDFViewerApplication;
      if (app && app.pdfDocument && typeof app.pdfDocument.getData === 'function') {
        const data = await app.pdfDocument.getData(); // Uint8Array
        return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(data));
      }
    } catch {}
    return null;
  }

  async function getPdfBase64WithRetries() {
    // try current window, then scan all iframes (same-origin), with short retries
    const attempts = 8;
    for (let i = 0; i < attempts; i++) {
      // current window first
      let b64 = await getPdfFromViewerOnce(window);
      if (b64) return b64;

      // scan iframes
      const frames = Array.from(document.querySelectorAll('iframe'));
      for (const f of frames) {
        try {
          if (!f.contentWindow) continue;
          b64 = await getPdfFromViewerOnce(f.contentWindow);
          if (b64) return b64;
        } catch {/* cross-origin or sandboxed */}
      }

      // small backoff before next try (PDF.js might still be initializing)
      await sleep(200);
    }

    // last-ditch: if ?src is a non-blob URL on same origin, fetch and convert
    try {
      const src = getQuery().get('src');
      if (src && !src.startsWith('blob:')) {
        const abs = new URL(src, window.location.origin).toString();
        if (abs.startsWith(window.location.origin)) {
          const resp = await fetch(abs, { credentials: 'include' });
          if (resp.ok) {
            const ab = await resp.arrayBuffer();
            return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(ab));
          }
        }
      }
    } catch {}

    return null;
  }

  async function promptForUnitNumber() {
    return await new Promise((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:#111;border:1px solid #333;padding:16px;border-radius:10px;min-width:320px;color:#fff;font:14px system-ui';
      modal.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px">Enter Unit # (must match Fleetio "name")</div>
        <input id="unitInput" style="width:100%;background:#0b0b0c;border:1px solid #333;color:#fff;padding:8px;border-radius:8px;margin-bottom:12px" placeholder="e.g., AAN Coach or 255" />
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="unitCancel" style="padding:8px 12px;background:#333;border-radius:8px">Cancel</button>
          <button id="unitOK" style="padding:8px 12px;background:#22c55e;color:#000;border-radius:8px">Use</button>
        </div>`;
      overlay.appendChild(modal); document.body.appendChild(overlay);
      modal.querySelector('#unitCancel').onclick = () => { document.body.removeChild(overlay); reject(new Error('cancelled')); };
      modal.querySelector('#unitOK').onclick = () => {
        const val = modal.querySelector('#unitInput').value.trim();
        document.body.removeChild(overlay);
        if (!val) reject(new Error('empty'));
        else resolve(val);
      };
    });
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

      // If unit is missing, prompt once (simple, per your request)
      if (!ctx.unitNumber) {
        try {
          const typed = await promptForUnitNumber();
          ctx.unitNumber = typed;
          // persist for this tab so subsequent clicks don’t ask again
          try {
            const raw = sessionStorage.getItem('schedule4Data');
            const base = raw ? JSON.parse(raw) : {};
            base.unitNumber = typed;
            sessionStorage.setItem('schedule4Data', JSON.stringify(base));
          } catch {}
        } catch (e) {
          if (e.message !== 'cancelled') uiAlert('Unit # is required.');
          return;
        }
      }

      // Always pull exact bytes from PDF.js (avoid blob: fetches)
      const pdfBase64 = await getPdfBase64WithRetries();
      if (!pdfBase64) {
        uiAlert('Unable to read the open PDF from the viewer. Please ensure this is the PDF viewer (PDF.js) and try again.');
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
        pdfBase64 // no pdfUrl -> avoids blob issues entirely
      };

      let res = await postJson('/api/fleetio/create-work-order', payload);

      // If server couldn’t find the vehicle, show picker with choices
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
          modal.querySelector('#fleetioOK').onclick = () => { const sel = modal.querySelector('#fleetioVehicleSelect'); const id = sel.value; document.body.removeChild(overlay); resolve(id); };
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
