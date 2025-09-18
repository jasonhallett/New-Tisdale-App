// /js/fleetio-integration.js
// Solid client for creating a Fleetio Work Order:
//
// - NUKES duplicate handlers by cloning the button (removes all other listeners & inline onclick)
// - WILL NOT POST unless BOTH Unit # and a real PDF (base64 from PDF.js) are ready
// - Waits for PDF.js to initialize (short retries) and extracts exact bytes (no blob: fetches)
// - If Unit # is missing, prompts once and persists to sessionStorage for the tab
//
// Server endpoint assumed: /api/fleetio/create-work-order

(function () {
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  function $(sel) { return document.querySelector(sel); }
  function getQuery() { try { return new URL(window.location.href).searchParams; } catch { return new URLSearchParams(); } }
  function parseNumber(n) { if (n==null) return null; const s=String(n).replace(/,/g,'').trim(); if(!s) return null; const x=Number(s); return Number.isFinite(x)?x:null; }
  function alertBox(msg){ try{ alert(msg); }catch{} }

  function bytesToBase64(u8) {
    let i=0, out='', CHUNK=0x8000;
    for (; i<u8.length; i+=CHUNK) out += String.fromCharCode.apply(null, u8.subarray(i, i+CHUNK));
    return btoa(out);
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

  async function postJson(url, body) {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const ct = r.headers.get('content-type')||''; const json = ct.includes('application/json')? await r.json():null;
    if (!r.ok) {
      if (r.status===404 && json?.code==='vehicle_not_found') return json; // handled by caller
      throw new Error(json?.error || `HTTP ${r.status}`);
    }
    return json;
  }

  async function waitForPdfDoc(win, maxMs=6000) {
    const start = Date.now();
    while (Date.now()-start < maxMs) {
      try {
        const app = win.PDFViewerApplication;
        if (app?.initialized) {
          // PDF.js >=2.10 exposes initializedPromise; still, try direct access first
          const doc = app.pdfDocument || app._pdfDocument || app.pdfViewer?._pdfDocument;
          if (doc && typeof doc.getData === 'function') return doc;
        }
      } catch {}
      await sleep(150);
    }
    return null;
  }

  async function getPdfBase64FromAnyViewer() {
    // 1) This window
    let doc = await waitForPdfDoc(window, 6000);
    if (doc) {
      const data = await doc.getData(); return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(data));
    }
    // 2) Any same-origin iframe
    const frames = Array.from(document.querySelectorAll('iframe'));
    for (const f of frames) {
      try {
        if (!f.contentWindow) continue;
        const d2 = await waitForPdfDoc(f.contentWindow, 4000);
        if (d2) { const data2 = await d2.getData(); return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(data2)); }
      } catch {}
    }
    // 3) Last-ditch: if ?src is same-origin non-blob, fetch it and convert
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

  async function promptForUnit() {
    return await new Promise((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:#111;border:1px solid #333;padding:16px;border-radius:10px;min-width:320px;color:#fff;font:14px system-ui';
      modal.innerHTML = `
        <div style="font-weight:600;margin-bottom:8px">Enter Unit # (must equal Fleetio "name")</div>
        <input id="unitInput" style="width:100%;background:#0b0b0c;border:1px solid #333;color:#fff;padding:8px;border-radius:8px;margin-bottom:12px" />
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="unitCancel" style="padding:8px 12px;background:#333;border-radius:8px">Cancel</button>
          <button id="unitOK" style="padding:8px 12px;background:#22c55e;color:#000;border-radius:8px">Use</button>
        </div>`;
      overlay.appendChild(modal); document.body.appendChild(overlay);
      modal.querySelector('#unitCancel').onclick = () => { document.body.removeChild(overlay); reject(new Error('cancelled')); };
      modal.querySelector('#unitOK').onclick = () => {
        const v = modal.querySelector('#unitInput').value.trim();
        document.body.removeChild(overlay);
        v ? resolve(v) : reject(new Error('empty'));
      };
    });
  }

  async function handleClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const btn = this;
    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1'; btn.disabled = true;

    try {
      const ctx = getContext();

      // Ensure Unit #
      if (!ctx.unitNumber) {
        try {
          const typed = await promptForUnit();
          ctx.unitNumber = typed;
          try {
            const raw = sessionStorage.getItem('schedule4Data'); const base = raw ? JSON.parse(raw) : {};
            base.unitNumber = typed; sessionStorage.setItem('schedule4Data', JSON.stringify(base));
          } catch {}
        } catch (err) {
          if (err.message !== 'cancelled') alertBox('Unit # is required.');
          return; // DO NOT POST
        }
      }

      // Ensure PDF base64 (no blob fetches)
      const pdfBase64 = await getPdfBase64FromAnyViewer();
      if (!pdfBase64) {
        alertBox('Could not read the open PDF from the viewer. Please confirm this is the PDF viewer page and try again.');
        return; // DO NOT POST
      }

      // Build payload ONLY now (guards against accidental POSTs)
      const dateStr = ctx.inspectionDate || new Date().toISOString().slice(0,10);
      const safeUnit = ctx.unitNumber.replace(/[^\w\-]+/g, '_');
      const filename = `Schedule-4_Inspection_${safeUnit}_${dateStr}.pdf`;

      const payload = {
        inspectionId: ctx.inspectionId,
        unitNumber: ctx.unitNumber,
        data: { inspectionDate: ctx.inspectionDate, odometer: ctx.odometer },
        filename,
        pdfBase64
      };

      const res = await postJson('/api/fleetio/create-work-order', payload);

      if (res?.code === 'vehicle_not_found') {
        // only then show picker
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

        const res2 = await postJson('/api/fleetio/create-work-order', { ...payload, vehicleId: id });
        if (res2?.ok) {
          window.open(res2.work_order_url, '_blank');
          alertBox('Fleetio Work Order created and PDF attached.');
          return;
        }
        alertBox('Fleetio error: ' + JSON.stringify(res2 || {}, null, 2));
        return;
      }

      if (res?.ok) {
        window.open(res.work_order_url, '_blank');
        alertBox('Fleetio Work Order created and PDF attached.');
        return;
      }

      alertBox('Fleetio error: ' + JSON.stringify(res || {}, null, 2));
    } catch (err) {
      if (err?.message !== 'cancelled') {
        console.error(err);
        alertBox('Fleetio Error: ' + (err?.message || String(err)));
      }
    } finally {
      btn.disabled = false; btn.dataset.busy = '0';
    }
  }

  function replaceWithClone(el) {
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    return clone;
  }

  window.addEventListener('DOMContentLoaded', () => {
    let btn = document.querySelector('#btnFleetio, [data-action="fleetio"], .btn-fleetio');
    if (!btn) return;

    // Strip ALL existing handlers (including inline) by cloning node
    btn = replaceWithClone(btn);
    btn.removeAttribute('onclick');

    // Bind our single handler
    btn.addEventListener('click', handleClick, { once: false });
  });
})();
