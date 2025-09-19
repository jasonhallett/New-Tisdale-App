// /js/fleetio.js
// DEBUG RESET: single handler + detailed debug modal + robust PDF sourcing (base64 OR pdfUrl fallback).

(function () {
  const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

  function $(sel){ return document.querySelector(sel); }
  function getQuery(){ try { return new URL(window.location.href).searchParams; } catch { return new URLSearchParams(); } }
  function parseNumber(n){ if(n==null) return null; const s=String(n).replace(/,/g,'').trim(); if(!s) return null; const x=Number(s); return Number.isFinite(x)?x:null; }

  // ---------- Debug modal ----------
  function createDebugModal(){
    // DEBUG MODAL DISABLED — using console logger only.
    // If you want the visual modal back, restore the previous implementation.
    function log(line){ try { console.log('[Fleetio]', line); } catch {} }
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
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status; err.text = text; err.json = json;
      throw err;
    }
    return json ?? {};
  }

  async function fetchToBase64(url){
    try {
      const res = await fetch(url);
      const buf = await res.arrayBuffer();
      const b64 = bytesToBase64(new Uint8Array(buf));
      return `data:application/pdf;base64,${b64}`;
    } catch (e) { return null; }
  }

  async function findPdf(log){
    // 1) <embed> or <object>
    const em = document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
    if (em) {
      const src = em.getAttribute('src') || em.getAttribute('data') || '';
      if (src.startsWith('data:application/pdf')) {
        log('PDF source: <embed>/<object> data: URL -> base64');
        return { pdfBase64: src, from: 'embed-dataurl' };
      }
      if (src.startsWith('blob:')) {
        log('PDF source: <embed>/<object> blob: -> base64 via fetch');
        const b64 = await fetchToBase64(src);
        if (b64) return { pdfBase64: b64, from: 'embed-blob' };
      }
      try {
        const abs = new URL(src, window.location.origin).toString();
        if (abs.startsWith(window.location.origin)) {
          log('PDF source: <embed>/<object> same-origin URL -> pdfUrl');
          return { pdfUrl: abs, from: 'embed-url' };
        }
      } catch {}
    }

    // 2) <iframe>
    const ifr = document.querySelector('iframe[src*=".pdf"], iframe[src^="blob:"], iframe[src^="data:application/pdf"]');
    if (ifr) {
      const src = ifr.getAttribute('src') || '';
      if (src.startsWith('data:application/pdf')) {
        log('PDF source: <iframe> data: URL -> base64');
        return { pdfBase64: src, from: 'iframe-dataurl' };
      }
      if (src.startsWith('blob:')) {
        log('PDF source: <iframe> blob: -> base64 via fetch');
        const b64 = await fetchToBase64(src);
        if (b64) return { pdfBase64: b64, from: 'iframe-blob' };
      }
      try {
        const abs = new URL(src, window.location.origin).toString();
        if (abs.startsWith(window.location.origin)) {
          log('PDF source: <iframe> same-origin URL -> pdfUrl');
          return { pdfUrl: abs, from: 'iframe-url' };
        }
      } catch {}
    }

    // 3) <a download>
    const link = document.querySelector('a[download][href*=".pdf"], a[download][href^="blob:"], a[download][href^="data:application/pdf"]');
    if (link) {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('data:application/pdf')) {
        log('PDF source: <a> data: URL -> base64');
        return { pdfBase64: href, from: 'a-dataurl' };
      }
      if (href.startsWith('blob:')) {
        log('PDF source: <a> blob: -> base64 via fetch');
        const b64 = await fetchToBase64(href);
        if (b64) return { pdfBase64: b64, from: 'a-blob' };
      }
      try {
        const abs = new URL(href, window.location.origin).toString();
        if (abs.startsWith(window.location.origin)) {
          log('PDF source: <a> same-origin URL -> pdfUrl');
          return { pdfUrl: abs, from: 'a-url' };
        }
      } catch {}
    }

    // 4) if the viewer injected a data: URL into a frame (pdf_viewer.html)
    try {
      const f = document.querySelector('iframe');
      if (f && f.contentWindow) {
        // try to read an embedded data: URL
        const doc = f.contentDocument || f.contentWindow.document;
        const em2 = doc && doc.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
        if (em2) {
          const src = em2.getAttribute('src') || em2.getAttribute('data') || '';
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
      }
    } catch {}

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
        const abs = new URL(srcParam, window.location.origin).toString();
        if (abs.startsWith(window.location.origin)) {
          log('PDF source: ?src same-origin URL -> pdfUrl');
          return { pdfUrl: abs, from: 'src-url' };
        }
      } catch {}
    }

    return null;
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
      if (!ctx.inspectionId) { log('ERROR: Missing inspectionId in URL or session.'); throw new Error('Missing inspectionId'); }

      // Unit
      if (!ctx.unitNumber) {
        log('Missing unit number; attempting to derive from filename or prompt user.');
        if (ctx.filename) {
          const u = deriveUnitFromFilename(ctx.filename);
          if (u) { ctx.unitNumber = u; log(`Derived unit from filename: ${u}`); }
        }
        if (!ctx.unitNumber) {
          const base = JSON.parse(sessionStorage.getItem('schedule4Data') || '{}');
          const u2 = prompt('Enter Unit # (e.g., 350):', base.unitNumber || '');
          if (!u2) { log('User cancelled entering unit number.'); return; }
          ctx.unitNumber = u2;
          try {
            base.unitNumber = ctx.unitNumber; sessionStorage.setItem('schedule4Data', JSON.stringify(base));
          } catch {}
          log(`Unit number provided: ${ctx.unitNumber}`);
        } else {
          log(`Unit number ready: ${ctx.unitNumber}`);
        }
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

      // Handle create response
      if (!res || !res.ok) {
        log('ERROR: Fleetio route returned non-ok: ' + JSON.stringify(res));
        alert('Fleetio error: Could not obtain a real PDF to attach. Provide pdfBase64 or pdfUrl to the actual file.');
        return;
      }

      // Belt & suspenders: if server didn’t persist (e.g., no_db), push minimal update via /api/inspections
      if (!res.db_update || !res.db_update.ok) {
        log('DB update from Fleetio route not ok (' + JSON.stringify(res.db_update) + '). Attempting client follow-up save.');
        try {
          await postJson('/api/inspections', {
            id: payload.inspectionId,
            internal_work_order_number: res.work_order_number,
            fleetio_work_order_id: res.work_order_id
          });
          log('Client follow-up save to /api/inspections succeeded.');
        } catch (e) {
          log('Client follow-up save failed: ' + (e && e.message));
        }
      } else {
        log('Server DB update succeeded: ' + JSON.stringify(res.db_update));
      }

        log('Opening Fleetio Work Order URL: ' + res.url);
        window.open(res.url, '_blank', 'noopener');

    } catch (err) {
      console.error(err);
      alert('Fleetio error: ' + (err?.message || err));
    } finally {
      try { await sleep(350); } catch {}
      // close modal if it existed (no-op in logger mode)
      try { (createDebugModal().close || (()=>{}))(); } catch {}
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
