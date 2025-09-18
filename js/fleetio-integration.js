// /js/fleetio-integration.js
// Finds the displayed PDF, captures it (base64) when possible,
// and always sends the current page URL so the server can force ?id=<inspectionId>
// to generate a correct PDF if capture fails.

(function () {
  function $(sel) { return document.querySelector(sel); }
  function getQuery() { const u = new URL(window.location.href); return u.searchParams; }

  function guessFilename(unit, dateStr) {
    const date = dateStr ? new Date(dateStr) : new Date();
    const y = date.getFullYear(), m = String(date.getMonth()+1).padStart(2,'0'), d = String(date.getDate()).padStart(2,'0');
    const unitSafe = (unit || 'unit').toString().replace(/[^A-Za-z0-9._-]+/g, '-');
    return `Schedule4_${unitSafe}_${y}-${m}-${d}.pdf`;
  }

  async function findPdfSrc() {
    // Embedded candidates
    const iframe = document.querySelector('iframe[src$=".pdf"], iframe[type="application/pdf"], #pdfFrame, .pdf-iframe');
    const embed  = document.querySelector('embed[type="application/pdf"], embed[src$=".pdf"]');
    const objectEl = document.querySelector('object[type="application/pdf"], object[data$=".pdf"]');
    const candidates = [];
    if (iframe && iframe.src) candidates.push(iframe.src);
    if (embed && embed.src) candidates.push(embed.src);
    if (objectEl && objectEl.data) candidates.push(objectEl.data);

    // Or your viewer passed ?src=...
    const q = getQuery();
    const srcParam = q.get('src'); if (srcParam) candidates.push(srcParam);

    for (const src of candidates) {
      if (!src) continue;
      if (/^data:application\/pdf/i.test(src)) return src;
      if (/^blob:/i.test(src)) return src;
      if (/\.pdf(\?|$)/i.test(src)) return src;
      if (/\/api\/pdf\/print/i.test(src)) return src; // server can render
    }
    return null;
  }

  async function fetchPdfBase64(src) {
    if (!src) throw new Error('No PDF src');
    if (src.startsWith('data:application/pdf')) return src;
    // blob: and same-origin URLs should fetch
    const resp = await fetch(src);
    if (!resp.ok) throw new Error(`Failed to fetch PDF: ${resp.status}`);
    const ab = await resp.arrayBuffer();
    let binary = '', bytes = new Uint8Array(ab), chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return `data:application/pdf;base64,${btoa(binary)}`;
  }

  function parseNumber(n) {
    if (n == null) return null;
    const s = String(n).replace(/,/g,'').trim();
    if (!s) return null;
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }

  function findUnitFromDom() {
    const el = document.querySelector('#unitNumber, [data-unit], [data-unit-number]');
    if (el) {
      const v = el.getAttribute('data-unit') || el.getAttribute('data-unit-number') || el.value || el.textContent;
      if (v) return v.trim();
    }
    const text = document.body?.innerText || '';
    const m = text.match(/Unit\s*#?\s*[:\-]?\s*([A-Za-z0-9\-]+)/i);
    if (m) return m[1];
    return null;
  }

  function getContext() {
    const q = getQuery();
    const ctx = {
      inspectionId: q.get('id') || null,
      inspectionDate: q.get('date') || q.get('inspected_at') || q.get('inspected') || null,
      unitNumber: q.get('unit') || q.get('vehicle') || q.get('unit_number') || null,
      odometer: parseNumber(q.get('odo') || q.get('odometer'))
    };
    if (!ctx.unitNumber) ctx.unitNumber = findUnitFromDom();
    if (window.TBL && typeof window.TBL === 'object') {
      ctx.inspectionId = ctx.inspectionId || window.TBL.inspectionId || null;
      ctx.inspectionDate = ctx.inspectionDate || window.TBL.inspectionDate || null;
      ctx.unitNumber = ctx.unitNumber || window.TBL.unitNumber || null;
      ctx.odometer = ctx.odometer ?? parseNumber(window.TBL.odometer);
    }
    return ctx;
  }

  async function postJson(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ct = r.headers.get('content-type') || '';
    const json = ct.includes('application/json') ? await r.json() : { ok: r.ok, text: await r.text() };
    if (!r.ok) {
      const err = new Error(json?.error || `HTTP ${r.status}`);
      err.step = json?.step; err.details = json?.details; err.payload = json; throw err;
    }
    return json;
  }

  function ensure(val, label) {
    if (val == null || val === '') throw new Error(`${label} is required`);
    return val;
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

      const ctx = getContext();
      const inspectionId = ensure(ctx.inspectionId, 'Inspection Id');
      const unitNumber = ctx.unitNumber || prompt('Unit # not found on page. Enter the Fleet Unit #:');
      const inspectionDate = ctx.inspectionDate || new Date().toISOString().slice(0,10);
      const odometer = ctx.odometer;

      // Try to capture the exact PDF currently shown
      const src = await findPdfSrc();
      let pdfDataUrl = null;
      if (src) {
        try { pdfDataUrl = await fetchPdfBase64(src); }
        catch (e) { console.warn('PDF capture failed; server will render from URL:', e); }
      }

      const filename = guessFilename(unitNumber, inspectionDate);

      // Always pass current page URL so server can force ?id= and render if capture is invalid/missing
      const payload = {
        inspectionId,
        unitNumber,
        data: { inspectionDate, odometer },
        filename,
        pdfBase64: pdfDataUrl || null,
        reportUrl: window.location.href
      };

      const res = await postJson('/api/fleetio/create-work-order', payload);
      if (res?.ok) {
        window.open(res.work_order_url, '_blank');
        alert('Fleetio Work Order created and PDF attached.');
        return;
      }
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
