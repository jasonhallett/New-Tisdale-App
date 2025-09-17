async function fetchList(){
  const r = await fetch('/api/schedule4s/list', { credentials:'include' });
  if (!r.ok) throw new Error('Failed to load Schedule 4s');
  const j = await r.json();
  return Array.isArray(j.items) ? j.items : [];
}
function fmtDate(iso){
  try{
    const d = new Date(iso);
    if (isNaN(+d)) return '—';
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }catch{ return '—'; }
}
function htmlesc(s){ return String(s ?? '').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function render(items){
  const tbody = document.querySelector('#grid tbody');
  tbody.innerHTML = items.map((row, i) => {
    const id = row.id;
    const date = fmtDate(row.created_at);
    const unit = htmlesc(row.unit || row.unit_number || row.vehicle || '—');
    const tech = htmlesc(row.technician || row.technician_name || '—');
    const status = htmlesc(row.status || '—');
    return `<tr>
      <td>${i+1}</td>
      <td>${date}</td>
      <td>${unit}</td>
      <td>${tech}</td>
      <td>${status}</td>
      <td>
        <div class="row">
          <a class="btn-ghost" href="output.html?id=${encodeURIComponent(id)}" target="_top" title="Open Output" style="height:32px;padding:0 10px">Open</a>
        </div>
      </td>
    </tr>`
  }).join('');
}

function attachFilter(all){
  const q = document.getElementById('q');
  const doFilter = () => {
    const t = (q.value || '').toLowerCase();
    const filtered = !t ? all : all.filter(r => {
      const s = `${r.id||''} ${r.unit||r.unit_number||''} ${r.technician||r.technician_name||''} ${r.status||''} ${r.created_at||''}`.toLowerCase();
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
  try{
    const items = await fetchList();
    attachFilter(items);
  }catch(e){
    console.error(e);
    document.querySelector('#grid tbody').innerHTML = `<tr><td colspan="6">Unable to load Schedule 4s.</td></tr>`;
  }
})();
