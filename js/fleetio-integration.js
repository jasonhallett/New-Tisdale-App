// /js/fleetio-integration.js
// Attaches the EXACT PDF that's open or downloadable — no re-rendering.
// If we can't read bytes in the browser, we pass pdfUrl so the server fetches the exact file.
// Also: reads inspection/unit/odometer from sessionStorage.schedule4Data when available.
// Treats server 404 {code:'vehicle_not_found'} as normal to show picker (no second POST until selected).

(function () {
  function $(sel) { return document.querySelector(sel); }
  function getQuery() { const u = new URL(window.location.href); return u.searchParams; }
  function parseNumber(n) {
    if (n == null) return null;
    const s = String(n).replace(/,/g,'').trim(); if (!s) return null;
    const x = Number(s); return Number.isFinite(x) ? x : null;
  }
  function uint8ToBase64(u8) {
    let i = 0, chunks = [], CHUNK = 0x8000;
    for (; i < u8.length; i += CHUNK) chunks.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK)));
    return btoa(chunks.join(''));
  }

  function fromSchedule4Data(ctx) {
    try {
      const raw = sessionStorage.getItem('schedule4Data');
      if (!raw) return ctx;
      const d = JSON.parse(raw);
      ctx.inspectionId  = ctx.inspectionId  || d.id || d.inspectionId || d.InspectionId || null;
      ctx.inspectionDate= ctx.inspectionDate|| d.inspectionDate || d.date || d.dateInspected || null;
      ctx.unitNumber    = ctx.unitNumber    || d.unitNumber || d.unit || d.vehicle || d.unit_number || null;
      ctx.odometer      = (ctx.odometer ?? parseNumber(d.odometer ?? d.startOdometer ?? d.odo ?? d.mileage));
      return ctx;
    } catch { return ctx; }
  }

  function getContext() {
    const q = getQuery();
    let ctx = {
      inspectionId: q.get('id') || null,
      inspectionDate: q.get('date') || q.get('inspected_at') || q.get('inspected') || null,
      unitNumber: q.get('unit') || q.get('vehicle') || q.get('unit_number') || null,
      odometer: parseNumber(q.get('odo') || q.get('odometer'))
    };
    ctx = fromSchedule4Data(ctx);
    if (window.TBL && typeof window.TBL === 'object') {
      ctx.inspectionId = ctx.inspectionId || window.TBL.inspectionId || null;
      ctx.inspectionDate = ctx.inspectionDate || window.TBL.inspectionDate || null;
      ctx.unitNumber = ctx.unitNumber || window.TBL.unitNumber || null;
      ctx.odometer = ctx.odometer ?? parseNumber(window.TBL.odometer);
    }
    return ctx;
  }

  function sameOriginUrl(u) {
    try { const x = new URL(u, window.location.origin); return x.origin === window.location.origin ? x.toString() : null; } catch { return null; }
  }

  function downloadHrefCandidate() {
    const a = document.querySelector('#btnDownload[href], a[data-download], a[download][href]');
    if (a && a.getAttribute('href')) return a.getAttribute('href');
    const el = document.querySelector('[data-download-url]');
    if (el) return el.getAttribute('data-download-url');
    return null;
  }

  function framePdfCandidate() {
    const frame = document.getElementById('pdfFrame');
    if (frame && frame.src) return frame.src;
    const iframe = document.querySelector('iframe[src], iframe[data-src]');
    if (iframe) return iframe.getAttribute('src') || iframe.getAttribute('data-src');
    const embed  = document.querySelector('embed[type="application/pdf"], embed[src$=".pdf"]');
    if (embed && embed.src) return embed.src;
    const obj    = document.querySelector('object[type="application/pdf"]');
    if (obj && obj.data) return obj.data;
    return null;
  }

  async function getOpenPdfDataUrlOrUrl() {
    // 1) PDF.js direct bytes (preferred)
    try {
      const app = window.PDFViewerApplication;
      if (app && app.pdfDocument && typeof app.pdfDocument.getData === 'function') {
        const data = await app.pdfDocument.getData(); // Uint8Array
        return { pdfBase64: 'data:application/pdf;base64,' + uint8ToBase64(new Uint8Array(data)) };
      }
    } catch (e) { console.warn('PDF.js getData failed:', e); }

    // 2) Use explicit download href if present
    let href = downloadHrefCandidate();
    if (href) {
      if (href.startsWith('data:application/pdf')) return { pdfBase64: href };
      if (href.startsWith('blob:') || sameOriginUrl(href)) {
        try {
          const resp = await fetch(href); if (resp.ok) {
            const ab = await resp.arrayBuffer();
            return { pdfBase64: 'data:application/pdf;base64,' + uint8ToBase64(new Uint8Array(ab)) };
          }
        } catch {}
      }
      // otherwise send the url for server-side fetch
      return { pdfUrl: href };
    }

    // 3) Use the frame/embed/object src
    const src = framePdfCandidate();
    if (src) {
      if (src.startsWith('data:application/pdf')) return { pdfBase64: src };
      if (src.startsWith('blob:') || sameOriginUrl(src)) {
        try {
          const resp = await fetch(src); if (resp.ok) {
            const ab = await resp.arrayBuffer();
            return { pdfBase64: 'data:application/pdf;base64,' + uint8ToBase64(new Uint8Array(ab)) };
          }
        } catch {}
      }
      return { pdfUrl: src };
    }

    // 4) As a last resort, if viewer has ?src= in the URL, use that
    const q = getQuery(); const qs = q.get('src');
    if (qs) return { pdfUrl: qs };

    throw new Error('Could not locate the open/downloadable PDF in this page.');
  }

  async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    const maybeJson = ct.includes('application/json');
    const payload = maybeJson ? await r.json() : { ok: r.ok, text: await r.text() };
    if (!r.ok) {
      if (r.status === 404 && payload && payload.code === 'vehicle_not_found') return payload;
      const err = new Error(payload?.error || `HTTP ${r.status}`);
      err.step = payload?.step; err.details = payload?.details; err.payload = payload; throw err;
    }
    return payload;
  }

  function showVehiclePicker(choices) {
    return new Promise((resolve, reject) => {
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
        const sel = modal.querySelector('#fleetioVehicleSelect'); const id = sel.value;
        document.body.removeChild(overlay); resolve(id);
      };
    });
  }

  let busy = false;

  async function onFleetioClick() {
    if (busy) return;
    busy = true;
    try {
      const btn = this;
      btn.disabled = true; btn.setAttribute('data-busy','1');

      let ctx = getContext();
      if (!ctx.inspectionId) throw new Error('Inspection Id is required');

      const { pdfBase64, pdfUrl } = await getOpenPdfDataUrlOrUrl();

      const filename = (() => {
        const unit = (ctx.unitNumber || 'Unit').toString().replace(/[^\w\-]+/g, '_');
        const d = ctx.inspectionDate || new Date().toISOString().slice(0,10);
        return `Schedule-4_Inspection_${unit}_${d}.pdf`;
      })();

      let payload = {
        inspectionId: ctx.inspectionId,
        unitNumber: ctx.unitNumber || null,
        data: { inspectionDate: ctx.inspectionDate, odometer: ctx.odometer },
        filename,
        pdfBase64: pdfBase64 || null,
        pdfUrl: pdfUrl || null
      };

      // First attempt: let server auto-match the vehicle
      let res = await postJson('/api/fleetio/create-work-order', payload);

      if (res?.code === 'vehicle_not_found') {
        const vehicleId = await showVehiclePicker(res.choices || []);
        res = await postJson('/api/fleetio/create-work-order', { ...payload, vehicleId });
      }

      if (res?.ok) {
        window.open(res.work_order_url, '_blank');
        const meterMsg = (res.current_meter != null) ? ` (Fleetio current meter: ${res.current_meter})` : '';
        alert('Fleetio Work Order created and PDF attached.' + meterMsg);
        return;
      }
      alert('Fleetio error: ' + JSON.stringify(res || {}, null, 2));
    } catch (err) {
      if (err.message !== 'cancelled') {
        console.error(err);
        alert('Fleetio Error: ' + (err?.message || String(err)));
      }
    } finally {
      const btn = this;
      btn.disabled = false; btn.removeAttribute('data-busy');
      busy = false;
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.querySelector('#btnFleetio, [data-action="fleetio"], .btn-fleetio');
    if (!btn) return;
    btn.addEventListener('click', onFleetioClick);
  });
})();
