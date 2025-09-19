// /js/fleetio.js
// DEBUG RESET: single handler + detailed debug modal + robust PDF sourcing (base64 OR pdfUrl fallback).

(function () {
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  function $(sel){ return document.querySelector(sel); }
  function getQuery(){ try { return new URL(window.location.href).searchParams; } catch { return new URLSearchParams(); } }
  function parseNumber(n){ if(n==null) return null; const s=String(n).replace(/,/g,'').trim(); if(!s) return null; const x=Number(s); return Number.isFinite(x)?x:null; }

  // ---------- Debug modal (removed; logs now go to console only) ----------
  function createDebugModal(){
    function log(line){
      try { console.debug('[Fleetio]', line); } catch {}
    }
    return { log, close: ()=>{} };
  }

  function bytesToBase64(u8){ let i=0,out='',CH=0x8000; for(;i<u8.length;i+=CH){ out += String.fromCharCode.apply(null,u8.subarray(i,i+CH)); } return btoa(out); }
  function deriveUnitFromFilename(name){ if(!name) return null; const m = name.match(/Schedule-4_Inspection_([^_]+)_\d{4}-\d{2}-\d{2}\.pdf$/i); return m ? m[1] : null; }

  function getCtx(log){
    const q = getQuery();
    let ctx = {
      inspectionId: q.get('id') || null,
      inspectionDate: q.get('date') || q.get('inspected_at') || q.get('inspected') || null,
      unitNumber: q.get('unit') || q.get('vehicle') || q.get('unit_number') || null,
      filename: q.get('filename') || null,
      odometer: parseNumber(q.get('odo') || q.get('odometer')),
      src: q.get('src') || ''
    };
    log(`Initial ctx from query: ${JSON.stringify(ctx)}`);

    if (!ctx.unitNumber && ctx.filename) {
      const u = deriveUnitFromFilename(ctx.filename); if (u) { ctx.unitNumber = u; log(`Derived unit from filename: ${u}`); }
    }

    try {
      const raw = sessionStorage.getItem('schedule4Data');
      if (raw) {
        const d = JSON.parse(raw);
        ctx.inspectionId   = ctx.inspectionId   || d.id || d.inspectionId || d.InspectionId || null;
        ctx.inspectionDate = ctx.inspectionDate || d.inspectionDate || d.date || d.dateInspected || null;
        ctx.unitNumber     = ctx.unitNumber     || d.unitNumber || d.unit || d.vehicle || d.unit_number || null;
        ctx.odometer       = (ctx.odometer ?? parseNumber(d.odometer ?? d.startOdometer ?? d.odo ?? d.mileage));
        log(`Augmented ctx from sessionStorage.schedule4Data: ${JSON.stringify({inspectionId:ctx.inspectionId,inspectionDate:ctx.inspectionDate,unitNumber:ctx.unitNumber,odometer:ctx.odometer})}`);
      } else {
        log('No sessionStorage.schedule4Data found.');
      }
    } catch (e) { log('Error parsing sessionStorage.schedule4Data: ' + e.message); }

    if (window.TBL && typeof window.TBL === 'object') {
      ctx.inspectionId   = ctx.inspectionId   || window.TBL.inspectionId || null;
      ctx.inspectionDate = ctx.inspectionDate || window.TBL.inspectionDate || null;
      ctx.unitNumber     = ctx.unitNumber     || window.TBL.unitNumber || null;
      ctx.odometer       = ctx.odometer ?? parseNumber(window.TBL.odometer);
      log(`Augmented ctx from window.TBL: ${JSON.stringify({inspectionId:ctx.inspectionId,inspectionDate:ctx.inspectionDate,unitNumber:ctx.unitNumber,odometer:ctx.odometer})}`);
    }

    return ctx;
  }

  async function postJson(url, body){
    const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (!r.ok) {
      if (r.status===404 && json?.code==='vehicle_not_found') return json;
      const msg = json?.error || `HTTP ${r.status}`;
      throw new Error(`${msg} :: ${text}`);
    }
    return json || {};
  }

  // ---------- PDF finders (client) ----------
  async function tryPdfJsBytes(win){
    try {
      const app = win.PDFViewerApplication;
      if (app && app.pdfDocument && typeof app.pdfDocument.getData === 'function') {
        const data = await app.pdfDocument.getData();
        return { pdfBase64: 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(data)), from: 'pdfjs' };
      }
    } catch {}
    return null;
  }

  async function fetchToBase64(url){
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return null;
    const ab = await resp.arrayBuffer();
    return 'data:application/pdf;base64,' + bytesToBase64(new Uint8Array(ab));
  }

  async function findPdf(log){
    // 1) PDF.js (this window)
    let got = await tryPdfJsBytes(window);
    if (got) { log('PDF source: pdfjs (window)'); return got; }

    // 2) PDF.js (any same-origin iframe)
    for (const f of Array.from(document.querySelectorAll('iframe'))) {
      try {
        if (!f.contentWindow) continue;
        got = await tryPdfJsBytes(f.contentWindow);
        if (got) { log('PDF source: pdfjs (iframe)'); return got; }
      } catch {}
    }

    // 3) Download link
    const a = document.querySelector('#btnDownload[href]');
    if (a && a.getAttribute('href')) {
      const href = a.getAttribute('href');
      if (href.startsWith('data:application/pdf')) {
        log('PDF source: #btnDownload data: URL -> base64');
        return { pdfBase64: href, from: 'download-dataurl' };
      }
      if (href.startsWith('blob:')) {
        log('PDF source: #btnDownload blob: -> base64 via fetch');
        const b64 = await fetchToBase64(href);
        if (b64) return { pdfBase64: b64, from: 'download-blob' };
      }
      // same-origin https? send as pdfUrl
      try {
        const abs = new URL(href, window.location.origin).toString();
        if (abs.startsWith(window.location.origin)) {
          log('PDF source: #btnDownload same-origin URL -> pdfUrl');
          return { pdfUrl: abs, from: 'download-url' };
        }
      } catch {}
    }

    // 4) iframe/object/embed src
    const frame = document.getElementById('pdfFrame') || document.querySelector('iframe,object,embed');
    const src = frame?.src || frame?.getAttribute?.('src') || '';
    if (src) {
      if (src.startsWith('data:application/pdf')) {
        log('PDF source: frame data: URL -> base64');
        return { pdfBase64: src, from: 'frame-dataurl' };
      }
      if (src.startsWith('blob:')) {
        log('PDF source: frame blob: -> base64 via fetch');
        const b64 = await fetchToBase64(src);
        if (b64) return { pdfBase64: b64, from: 'frame-blob' };
      }
      try {
        const abs2 = new URL(src, window.location.origin).toString();
        if (abs2.startsWith(window.location.origin)) {
          log('PDF source: frame same-origin URL -> pdfUrl');
          return { pdfUrl: abs2, from: 'frame-url' };
        }
      } catch {}
    }

    // 5) ?src= param
    const srcParam = getQuery().get('src');
    if (srcParam) {
      if (srcParam.startsWith('data:application/pdf')) {
        log('PDF source: ?src data: URL -> base64');
        return { pdfBase64: srcParam, from: 'src-dataurl' };
      }
      if (srcParam.startsWith('blob:')) {
        log('PDF source: ?src blob: -> base64 via fetch');
        const b64 = await fetchToBase64(srcParam);
        if (b64) return { pdfBase64: b64, from: 'src-blob' };
      }
      try {
        const abs3 = new URL(srcParam, window.location.origin).toString();
        if (abs3.startsWith(window.location.origin)) {
          log('PDF source: ?src same-origin URL -> pdfUrl');
          return { pdfUrl: abs3, from: 'src-url' };
        }
      } catch {}
    }

    return null;
  }

  async function selectVehicleFromChoices(choices, log){
    return await new Promise((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:1000000;display:flex;align-items:center;justify-content:center;';
      const modal = document.createElement('div');
      modal.style.cssText = 'background:#0b0b0c;color:#e5e7eb;border:1px solid #333;border-radius:12px;padding:16px;min-width:320px;max-width:90vw;';
      modal.innerHTML = `
        <div style="font-weight:600;margin-bottom:10px;">Select Fleetio Vehicle</div>
        <select id="veh" style="width:100%;background:#111;border:1px solid #333;color:#e5e7eb;padding:8px;border-radius:8px;margin-bottom:12px;">
          ${(choices||[]).map(c=>`<option value="${c.id}">${c.label}</option>`).join('')}
        </select>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="cancel" style="padding:8px 12px;background:#333;border-radius:8px;border:1px solid #444;color:#ddd">Cancel</button>
          <button id="ok" style="padding:8px 12px;background:#22c55e;color:#000;border-radius:8px;border:1px solid #16a34a">Use Vehicle</button>
        </div>
      `;
      overlay.appendChild(modal); document.body.appendChild(overlay);
      modal.querySelector('#cancel').onclick = ()=>{ document.body.removeChild(overlay); reject(new Error('cancelled')); };
      modal.querySelector('#ok').onclick = ()=>{ const id = modal.querySelector('#veh').value; document.body.removeChild(overlay); resolve(id); };
    });
  }

  async function onClick(e){
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();

    const dbg = createDebugModal();
    const log = dbg.log;
    log('=== Fleetio flow started ===');

    const btn = this;
    if (btn.dataset.busy==='1'){ log('Button busy guard engaged.'); return; }
    btn.dataset.busy='1'; btn.disabled = true;

    try {
      const ctx = getCtx(log);
      if(!ctx.inspectionId){ log('ERROR: Missing inspectionId.'); return; }

      if(!ctx.unitNumber){
        const initial = deriveUnitFromFilename(ctx.filename) || '';
        const typed = prompt('Enter Unit # (must equal Fleetio "name")', initial);
        if (!typed || !typed.trim()) { log('ERROR: Unit # missing/cancelled.'); return; }
        ctx.unitNumber = typed.trim();
        try {
          const raw = sessionStorage.getItem('schedule4Data'); const base = raw ? JSON.parse(raw) : {};
          base.unitNumber = ctx.unitNumber; sessionStorage.setItem('schedule4Data', JSON.stringify(base));
        } catch {}
        log(`Unit number provided: ${ctx.unitNumber}`);
      } else {
        log(`Unit number ready: ${ctx.unitNumber}`);
      }

      // Find PDF
      log('Locating PDF source...');
      const pdf = await findPdf(log);
      if (!pdf) { log('ERROR: Could not locate usable PDF (neither base64 nor URL).'); return; }
      if (pdf.pdfBase64) log(`PDF acquired via ${pdf.from}; size(base64)≈ ${pdf.pdfBase64.length.toLocaleString()} chars`);
      if (pdf.pdfUrl)    log(`PDF URL to be fetched by server via ${pdf.from}: ${pdf.pdfUrl}`);

      const unitSafe = (ctx.unitNumber || 'Unit').replace(/[^\w\-]+/g,'_');
      const dateStr = ctx.inspectionDate || new Date().toISOString().slice(0,10);
      const filename = ctx.filename || `Schedule-4_Inspection_${unitSafe}_${dateStr}.pdf`;
      log(`Filename resolved: ${filename}`);

      const payload = {
        inspectionId: ctx.inspectionId,
        unitNumber: ctx.unitNumber,
        data: { inspectionDate: ctx.inspectionDate, odometer: ctx.odometer },
        filename
      };
      if (pdf.pdfBase64) payload.pdfBase64 = pdf.pdfBase64;
      if (!pdf.pdfBase64 && pdf.pdfUrl) payload.pdfUrl = pdf.pdfUrl;

      log('POST /api/fleetio/create-work-order with payload keys: ' + Object.keys(payload).join(', '));
      let res = await postJson('/api/fleetio/create-work-order', payload);
      log('Server response (1): ' + JSON.stringify(res));

      if (res?.code === 'vehicle_not_found') {
        log('Vehicle not found by exact name. Showing picker...');
        const id = await selectVehicleFromChoices(res.choices || [], log);
        log(`Vehicle selected: ${id}`);
        res = await postJson('/api/fleetio/create-work-order', { ...payload, vehicleId: id });
        log('Server response (2): ' + JSON.stringify(res));
      }

      if (res?.ok) {
        const url = res.work_order_url;
        log('SUCCESS. Opening Fleetio: ' + url);
        window.open(url, '_blank');
        log('=== Flow complete ===');
        return;
      }

      log('ERROR: ' + JSON.stringify(res || {}, null, 2));
    } catch (err) {
      console.error(err);
      try { log('EXCEPTION: ' + (err?.message || String(err))); } catch {}
    } finally {
      btn.disabled = false; btn.dataset.busy='0';
    }
  }

  function bindOnce(){
    let btn = document.getElementById('btnFleetio') || document.querySelector('[data-action="fleetio"], .btn-fleetio');
    if(!btn) return;
    const clone = btn.cloneNode(true);
    btn.parentNode.replaceChild(clone, btn); // nuke old listeners/inline onclick
    clone.removeAttribute('onclick');
    clone.addEventListener('click', onClick, { once:false });
  }

  window.addEventListener('DOMContentLoaded', bindOnce);
})();
