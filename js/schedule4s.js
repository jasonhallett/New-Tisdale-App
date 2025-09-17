// js/schedule4s.js
// Grid: Date Inspected, Unit #, Odometer, Technician Name, Inspection Location, View (small link)

async function fetchList() {
  const r = await fetch('/api/schedule4s/list', { credentials: 'include' });
  if (!r.ok) throw new Error('Failed to load Schedule 4s');
  const j = await r.json();
  return Array.isArray(j.items) ? j.items : [];
}

function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(+d)) return '—';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  } catch { return '—'; }
}

function fmtOdo(v) {
  if (v === null || v === undefined) return '—';
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  if (!isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-CA');
}

function htmlesc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function buildOpenUrl(id) {
  const params = new URLSearchParams({ id, inspectionId: id, schedule4Id: id });
  return `output.html?${params.toString()}`;
}

function render(items) {
  const tbody = document.querySelector('#grid tbody');
  tbody.innerHTML = items.map((row) => {
    const id    = row.id;
    const date  = fmtDate(row.created_at);
    const unit  = htmlesc(row.unit || row.unit_number || row.vehicle || '—');
    const odo   = fmtOdo(row.odometer);
    const tech  = htmlesc(row.technician || row.technician_name || '—');
    const loc   = htmlesc(row.location || '—');
    const href  = id ? buildOpenUrl(id) : '#';
    return `<tr data-id="${htmlesc(id || '')}">
      <td class="col-date">${date}</td>
      <td class="col-unit">${unit}</td>
      <td class="col-odo">${odo}</td>
      <td class="col-tech cell-ellipsis" title="${tech}">${tech}</td>
      <td class="col-loc cell-ellipsis" title="${loc}">${loc}</td>
      <td class="col-view">
        <a class="btn-link-sm open-btn" href="${href}" target="_top" title="Open Output">View</a>
      </td>
    </tr>`;
  }).join('');

  // Delegate small link clicks
  tbody.addEventListener('click', (e) => {
    const a = e.target.closest('a.open-btn');
    if (!a) return;
    const tr = e.target.closest('tr');
    const id = tr?.getAttribute('data-id') || '';
    if (id) {
      try { sessionStorage.setItem('schedule4_last_open_id', id); } catch {}
      e.preventDefault();
      window.top.location.href = buildOpenUrl(id);
    }
  });
}

function attachFilter(all) {
  const q = document.getElementById('q');
  const doFilter = () => {
    const t = (q.value || '').toLowerCase();
    const filtered = !t ? all : all.filter(r => {
      const s = `${r.id||''} ${r.unit||r.unit_number||''} ${r.odometer||''} ${r.technician||r.technician_name||''} ${r.created_at||''} ${r.location||''}`.toLowerCase();
      return s.includes(t);
    });
    render(filtered);
  };
  q.addEventListener('input', doFilter);
  doFilter();
}

document.getElementById('newBtn').addEventListener('click', () => {
  try {
    const parentFrame = window.top?.document?.getElementById('contentFrame');
    if (parentFrame) {
      parentFrame.src = 'new_inspection.html';
      return;
    }
  } catch {}
  window.top.location.href = 'new_inspection.html';
});

(async () => {
  try {
    const items = await fetchList();
    attachFilter(items);
  } catch (e) {
    console.error(e);
    document.querySelector('#grid tbody').innerHTML = `<tr><td colspan="6">Unable to load Schedule 4s.</td></tr>`;
  }
})();