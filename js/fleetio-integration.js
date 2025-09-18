// /js/fleetio-integration.js
// 1) Deletes duplicate inline onclick handler at runtime (if present).
// 2) Hides the Fleetio button if DB already has internal_work_order_number or fleetio_work_order_id.
// 3) Posts once with either pdfBase64 or pdfUrl (no re-render).

(function () {
  function $(sel) { return document.querySelector(sel); }
  function getQuery() { try { return new URL(window.location.href).searchParams; } catch { return new URLSearchParams(); } }
  function parseNumber(n) { if (n==null) return null; const s=String(n).replace(/,/g,'').trim(); if(!s) return null; const x=Number(s); return Number.isFinite(x)?x:null; }
  function uint8ToBase64(u8){ let i=0, out=''; const CH=0x8000; for(;i<u8.length;i+=CH){ out+=String.fromCharCode.apply(null,u8.subarray(i,i+CH)); } return btoa(out); }

  async function fetchJson(url) {
    const r = await fetch(url, { credentials: 'include' });
    const ct = r.headers.get('content-type')||''; const json = ct.includes('application/json')? await r.json():null;
    if (!r.ok) throw new Error(json?.error || `HTTP ${r.status}`);
    return json;
  }
  async function postJson(url, body) {
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const ct = r.headers.get('content-type')||''; const json = ct.includes('application/json')? await r.json():null;
    if (!r.ok) {
      if (r.status===404 && json?.code==='vehicle_not_found') return json;
      throw new Error(json?.error || `HTTP ${r.status}`);
    }
    return json;
  }

  function fromSchedule4Data(ctx) {
    try {
      const raw = sessionStorage.getItem('schedule4Data'); if (!raw) return ctx;
      const d = JSON.parse(raw);
      ctx.inspectionId   = ctx.inspectionId   || d.id || d.inspectionId || d.InspectionId || null;
      ctx.inspectionDate = ctx.inspectionDate || d.inspectionDate || d.date || d.dateInspected || null;
      ctx.unitNumber     = ctx.unitNumber     || d.unitNumber || d.unit || d.vehicle || d.unit_number || null;
      ctx.odometer       = (ctx.odometer ?? parseNumber(d.odometer ?? d.startOdometer ?? d.odo ?? d.mileage));
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

  function sameOriginUrl(u){ try{ const x=new URL(u, window.location.origin); return x.origin===window.location.origin ? x.toString() : null; }catch{return null;} }
  function downloadHrefCandidate(){
    const a = document.querySelector('#btnDownload[href], a[data-download], a[download][href]');
    if (a && a.getAttribute('href')) return a.getAttribute('href');
    const el = document.querySelector('[data-download-url]');
    if (el) return el.getAttribute('data-download-url');
    return null;
  }
  function framePdfCandidate(){
    const frame = document.getElementById('pdfFrame'); if (frame && frame.src) return frame.src;
    const iframe = document.querySelector('iframe[src], iframe[data-src]'); if (iframe) return iframe.getAttribute('src') || iframe.getAttribute('data-src');
    const embed = document.querySelector('embed[type="application/pdf"], embed[src$=".pdf"]'); if (embed && embed.src) return embed.src;
    const obj = document.querySelector('object[type="application/pdf"]'); if (obj && obj.data) return obj.data;
    return null;
  }

  async function getOpenPdfDataUrlOrUrl() {
    try {
      const app = window.PDFViewerApplication;
      if (app && app.pdfDocument && typeof app.pdfDocument.getData === 'function') {
        const data = await app.pdfDocument.getData();
        return { pdfBase64: 'data:application/pdf;base64,' + uint8ToBase64(new Uint8Array(data)) };
      }
    } catch {}
    let href = downloadHrefCandidate();
    if (href) {
      if (href.startsWith('data:application/pdf')) return { pdfBase64: href };
      if (href.startsWith('blob:') || sameOriginUrl(href)) {
        try { const resp = await fetch(href); if (resp.ok){ const ab=await resp.arrayBuffer(); return { pdfBase64:'data:application/pdf;base64,'+uint8ToBase64(new Uint8Array(ab)) }; } } catch {}
      }
      return { pdfUrl: href };
    }
    const src = framePdfCandidate();
    if (src) {
      if (src.startsWith('data:application/pdf')) return { pdfBase64: src };
      if (src.startsWith('blob:') || sameOriginUrl(src)) {
        try { const resp = await fetch(src); if (resp.ok){ const ab=await resp.arrayBuffer(); return { pdfBase64:'data:application/pdf;base64,'+uint8ToBase64(new Uint8Array(ab)) }; } } catch {}
      }
      return { pdfUrl: src };
    }
    const q = getQuery(); const qs = q.get('src'); if (qs) return { pdfUrl: qs };
    throw new Error('Could not locate the open/downloadable PDF in this page.');
  }

  async function maybeHideFleetioButton(ctx) {
    if (!ctx.inspectionId) return;
    try {
      const r = await fetchJson(`/api/inspections/get?id=${encodeURIComponent(ctx.inspectionId)}`);
      const rec = r?.record;
      if (rec && (rec.internal_work_order_number || rec.fleetio_work_order_id)) {
        const btn = $('#btnFleetio, [data-action="fleetio"], .btn-fleetio');
        if (btn) btn.style.display = 'none';
      }
    } catch {}
  }

  async function onFleetioClick(e) {
    e.preventDefault();
    const btn = this;
    // Kill legacy inline onclick handler if present (de-dupe)
    btn.onclick = null; btn.removeAttribute('onclick');

    if (btn.dataset.busy === '1') return;
    btn.dataset.busy = '1'; btn.disabled = true;
    try {
      const ctx = getContext();
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

      let res = await postJson('/api/fleetio/create-work-order', payload);

      if (res?.code === 'vehicle_not_found') {
        // show picker
        const id = await new Promise((resolve, reject) => {
          const overlay = document.createElement('div');
          overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9999;';
          const modal = document.createElement('div');
          modal.style.cssText = 'background:#111;border:1px solid #333;padding:16px;border-radius:10px;min-width:320px;color:#fff;font:14px system-ui';
          modal.innerHTML = `
            <div style="font-weight:600;margin-bottom:8px">Select Fleetio Vehicle</div>
            <select id="fleetioVehicleSelect" style="width:100%;background:#0b0b0c;border:1px solid #333;color:#fff;padding:8px;border-radius:8px;margin-bottom:12px">
              ${res.choices.map(c=>`<option value="${c.id}">${c.label}</option>`).join('')}
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
        // lock the button on success by re-checking the DB (server saved it)
        await maybeHideFleetioButton(ctx);
        window.open(res.work_order_url, '_blank');
        alert('Fleetio Work Order created and PDF attached.');
        return;
      }

      alert('Fleetio error: ' + JSON.stringify(res || {}, null, 2));
    } catch (err) {
      if (err.message !== 'cancelled') {
        console.error(err);
        alert('Fleetio Error: ' + (err?.message || String(err)));
      }
    } finally {
      btn.disabled = false; btn.dataset.busy = '0';
    }
  }

  window.addEventListener('DOMContentLoaded', async () => {
    const btn = document.querySelector('#btnFleetio, [data-action="fleetio"], .btn-fleetio');
    if (!btn) return;
    // Remove any legacy inline handler BEFORE adding ours
    btn.onclick = null; btn.removeAttribute('onclick');
    btn.addEventListener('click', onFleetioClick, { once: false });
    // Hide button if already linked to a WO
    const ctx = getContext();
    await maybeHideFleetioButton(ctx);
  });
})();
