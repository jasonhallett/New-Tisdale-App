// /js/fleetio.js
// Single handler. Falls back to reading the iframe's blob/data URL if PDF.js isn't available.

(function () {
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
  function $(sel){ return document.querySelector(sel); }
  function getQuery(){ try { return new URL(window.location.href).searchParams; } catch { return new URLSearchParams(); } }
  function parseNumber(n){ if(n==null) return null; const s=String(n).replace(/,/g,'').trim(); if(!s) return null; const x=Number(s); return Number.isFinite(x)?x:null; }
  function alertBox(msg){ try{ alert(msg); }catch{} }
  function bytesToBase64(u8){ let i=0,out='',CH=0x8000; for(;i<u8.length;i+=CH){ out += String.fromCharCode.apply(null,u8.subarray(i,i+CH)); } return btoa(out); }

  function getCtx(){
    const q = getQuery();
    let ctx = {
      inspectionId: q.get('id') || null,
      inspectionDate: q.get('date') || q.get('inspected_at') || q.get('inspected') || null,
      unitNumber: q.get('unit') || q.get('vehicle') || q.get('unit_number') || null,
      filename: q.get('filename') || null,
      odometer: parseNumber(q.get('odo') || q.get('odometer')),
      src: q.get('src') || ''
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

  async function postJson(url, body){
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const ct = r.headers.get('content-type')||''; const json = ct.includes('application/json')? await r.json():null;
    if(!r.ok){
      if(r.status===404 && json?.code==='vehicle_not_found') return json;
      throw new Error(json?.error || `HTTP ${r.status}`);
    }
    return json;
  }

  async function waitForPdfDoc(win, maxMs=5000){
    const start = Date.now();
    while(Date.now()-start < maxMs){
      try{
        const app = win.PDFViewerApplication;
        if(app?.pdfDocument && typeof app.pdfDocument.getData === 'function') return app.pdfDocument;
      }catch{}
      await sleep(150);
    }
    return null;
  }

  async function getPdfBase64(){
    // Try PDF.js first
    let doc = await waitForPdfDoc(window, 5000);
    if(doc){ const data = await doc.getData(); return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(data)); }
    // Try any same-origin iframe PDF.js
    const frames = Array.from(document.querySelectorAll('iframe'));
    for(const f of frames){
      try{
        if(!f.contentWindow) continue;
        const d2 = await waitForPdfDoc(f.contentWindow, 3500);
        if(d2){ const data2 = await d2.getData(); return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(data2)); }
      }catch{}
    }
    // Fallback: read the iframe's src if it's blob: or data:application/pdf
    try{
      const frame = $('#pdfFrame');
      const src = frame?.src || getQuery().get('src') || '';
      if (src && (src.startsWith('blob:') || src.startsWith('data:application/pdf'))) {
        const resp = await fetch(src);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(ab));
        }
      }
    }catch{}
    return null;
  }

  async function ensureUnit(ctx){
    if (ctx.unitNumber && ctx.unitNumber.trim()) return ctx.unitNumber.trim();
    return await new Promise((resolve, reject)=>{
      const v = prompt('Enter Unit # (must equal Fleetio "name")');
      if (v && v.trim()) {
        try {
          const raw = sessionStorage.getItem('schedule4Data'); const base = raw ? JSON.parse(raw) : {};
          base.unitNumber = v.trim(); sessionStorage.setItem('schedule4Data', JSON.stringify(base));
        } catch {}
        resolve(v.trim());
      } else {
        reject(new Error('Unit # is required.'));
      }
    });
  }

  async function handleClick(e){
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const btn = this;
    if (btn.dataset.busy==='1') return;
    btn.dataset.busy='1'; btn.disabled = true;

    try{
      const ctx = getCtx();
      if(!ctx.inspectionId) { alertBox('Missing Inspection ID.'); return; }
      const unit = await ensureUnit(ctx);

      const pdfBase64 = await getPdfBase64();
      if(!pdfBase64){ alertBox('Could not read the open PDF from this viewer.'); return; }

      const unitSafe = unit.replace(/[^\w\-]+/g,'_');
      const dateStr = ctx.inspectionDate || new Date().toISOString().slice(0,10);
      const filename = ctx.filename || `Schedule-4_Inspection_${unitSafe}_${dateStr}.pdf`;

      const payload = {
        inspectionId: ctx.inspectionId,
        unitNumber: unit,
        data: { inspectionDate: ctx.inspectionDate, odometer: ctx.odometer },
        filename,
        pdfBase64
      };

      const res = await postJson('/api/fleetio/create-work-order', payload);

      if (res?.code === 'vehicle_not_found') {
        alertBox('Fleetio could not find a vehicle with that exact name. Please correct the Unit # or vehicle name in Fleetio.');
        return;
      }

      if (res?.ok) {
        window.open(res.work_order_url, '_blank');
        alertBox('Fleetio Work Order created and PDF attached.');
        return;
      }

      alertBox('Fleetio error: ' + JSON.stringify(res || {}, null, 2));
    }catch(err){
      console.error(err);
      if (err.message !== 'cancelled') alertBox(err.message || 'Error');
    }finally{
      btn.disabled = false; btn.dataset.busy='0';
    }
  }

  function bindOnce(){
    const orig = document.getElementById('btnFleetio') || document.querySelector('[data-action="fleetio"], .btn-fleetio');
    if(!orig) return;
    const btn = orig.cloneNode(true);
    orig.parentNode.replaceChild(btn, orig); // strip all existing listeners/onclick
    btn.removeAttribute('onclick');
    btn.addEventListener('click', handleClick, { once:false });
  }

  window.addEventListener('DOMContentLoaded', bindOnce);
})();
