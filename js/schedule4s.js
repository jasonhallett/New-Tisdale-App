// /js/schedule4s.js
// Renders Schedule 4 grid. "View" opens output.html.
// "New Schedule 4" uses openViewer(): centered popup on desktop, new tab on phones/tablets.

(function () {
  const $  = (sel, el = document) => el.querySelector(sel);

  // --- Utilities ---
  function fmtDateISOtoMDY(iso) {
    if (!iso) return '';
    const d = iso.length <= 10 ? new Date(iso + 'T00:00:00') : new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const y = d.getFullYear();
    return `${m}/${day}/${y}`;
  }
  function fmtNumber(n) {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(String(n).replace(/,/g, ''));
    if (!Number.isFinite(num)) return String(n);
    return num.toLocaleString('en-CA');
  }
  function esc(s) {
    return (s ?? '').toString().replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  // Build the "View" URL per record (fallback to output.html)
  function buildViewHref(r) {
    const id = r.id || r.record_id || r.inspection_id;
    const unit = (r.unit_number ?? r.unit ?? '').toString();
    const isoDate = (r.inspected_at || r.inspection_date || r.date || '').toString().slice(0, 10) || new Date().toISOString().slice(0, 10);
    const odometer = r.odometer ?? r.start_odometer ?? r.mileage ?? '';
    const filename = `Schedule-4_Inspection_${encodeURIComponent(unit)}_${isoDate}.pdf`;

    const params = new URLSearchParams({
      id: id ?? '',
      unit,
      odometer: String(odometer ?? ''),
      date: isoDate,
      filename
    });
    return { href: `./output.html?${params.toString()}`, external: false };
  }

  // --- Data normalization ---
  function normalizeRows(data) {
    return (
      (Array.isArray(data) && data) ||
      data?.rows ||
      data?.items ||
      data?.result?.rows ||
      data?.data?.rows ||
      data?.data?.items ||
      data?.data ||
      data?.results ||
      []
    );
  }

  // --- Data loading with 405 fallback ---
  async function fetchInspections(limit = 500) {
    const ts = Date.now();
    const getUrl = `/api/inspections?limit=${encodeURIComponent(limit)}&_=${ts}`;

    // 1) Try GET first
    try {
      const res = await fetch(getUrl, { credentials: 'include' });
      const text = await res.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch (e) {
        console.error('GET /api/inspections JSON parse failed:', e, 'raw:', text);
        throw new Error(`Failed to parse inspections JSON (${res.status})`);
      }
      if (res.ok) return normalizeRows(data);
      // If 405, fall through to POST attempts
      if (res.status !== 405) {
        console.error('GET /api/inspections failed:', res.status, data || text);
        throw new Error(`Failed to load inspections (${res.status})`);
      }
    } catch (e) {
      // Network or parsing error — we’ll still try POST next
      console.warn('GET /api/inspections error, will try POST:', e?.message || e);
    }

    // 2) Try POST with a simple "list" shape
    const postBodies = [
      { action: 'list', limit },     // common shape A
      { op: 'list', limit },         // common shape B
      { limit },                     // minimal
      {}                             // empty (some endpoints treat empty as "list")
    ];

    for (const body of postBodies) {
      try {
        const res = await fetch('/api/inspections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(body)
        });
        const text = await res.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) {
          console.error('POST /api/inspections JSON parse failed:', e, 'raw:', text);
          continue;
        }
        if (res.ok) return normalizeRows(data);
        // keep looping if not ok
      } catch (e) {
        // continue to next attempt
      }
    }

    // If we got here, all attempts failed
    throw new Error('Unable to load inspections: GET not allowed and POST attempts failed.');
  }

  // --- Rendering ---
  function renderRows(rows) {
    const tbody = $('#grid tbody');
    if (!tbody) return;
    tbody.innerHTML = rows.map(r => {
      const dateISO = (r.inspected_at || r.inspection_date || r.date || '').toString().slice(0, 10);
      const dateDisp = fmtDateISOtoMDY(dateISO);
      const unit = r.unit_number ?? r.unit ?? '';
      const odo = fmtNumber(r.odometer ?? r.start_odometer ?? r.mileage ?? '');
      const loc = r.inspection_location ?? r.location ?? r.inspected_at_location ?? '';
      const tech = r.technician_name ?? r.technician ?? r.tech_name ?? '';
      const view = buildViewHref(r);
      const viewAttr = view.external ? `target="_blank" rel="noopener"` : '';

      return `
        <tr data-id="${esc(r.id ?? '')}">
          <td class="col-date">${esc(dateDisp)}</td>
          <td class="col-unit">${esc(unit)}</td>
          <td class="col-odo tabular-nums">${esc(odo)}</td>
          <td class="col-loc"><span class="cell-ellipsis">${esc(loc)}</span></td>
          <td class="col-tech"><span class="cell-ellipsis">${esc(tech)}</span></td>
          <td class="col-view">
            <a class="btn btn-link-sm" href="${esc(view.href)}" ${viewAttr}>View</a>
          </td>
        </tr>
      `;
    }).join('');
  }

  function filterRows(rows, q) {
    if (!q) return rows;
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r => {
      const parts = [
        r.id, r.unit_number, r.unit, r.odometer, r.mileage, r.inspection_location,
        r.location, r.technician_name, r.technician, r.inspected_at, r.inspection_date
      ].map(v => (v ?? '').toString().toLowerCase());
      return parts.some(p => p.includes(needle));
    });
  }

  // --- Viewer open helpers (unchanged from your request) ---
  function openCentered(url, name, w, h) {
    const dualLeft = window.screenLeft ?? window.screenX ?? 0;
    const dualTop  = window.screenTop  ?? window.screenY ?? 0;
    const width  = window.innerWidth  ?? document.documentElement.clientWidth  ?? screen.width;
    const height = window.innerHeight ?? document.documentElement.clientHeight ?? screen.height;
    const left = Math.floor(dualLeft + (width  - w) / 2);
    const top  = Math.floor(dualTop  + (height - h) / 2);
    const features = [
      "noopener",
      `width=${w}`, `height=${h}`,
      `left=${left}`, `top=${top}`,
      `screenX=${left}`, `screenY=${top}`,
      "resizable", "scrollbars"
    ].join(",");
    return window.open(url, name, features);
  }
  function isMobileish() {
    const ua = navigator.userAgent || navigator.vendor || "";
    const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches ?? false;
    const smallScreen = Math.min(screen.width, screen.height) < 900;
    return /Android|iPhone|iPod|IEMobile|BlackBerry/i.test(ua) || iPadOS || (coarse && smallScreen);
  }
  function openViewer(viewerUrl) {
    if (isMobileish()) {
      const w = window.open(viewerUrl, "_blank", "noopener,noreferrer");
      if (w) w.opener = null;
      return w;
    }
    return openCentered(viewerUrl, "viewer", 1100, 700);
  }

  // --- Wire-up ---
  async function init() {
    const newBtn = $('#newBtn');
    if (newBtn) {
      newBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openViewer('./new_inspection.html');
      });
    }

    let allRows = [];
    try {
      allRows = await fetchInspections();
    } catch (e) {
      console.error(e);
    }
    renderRows(allRows);

    const q = $('#q');
    if (q) {
      q.addEventListener('input', () => {
        const filtered = filterRows(allRows, q.value);
        renderRows(filtered);
      });
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
