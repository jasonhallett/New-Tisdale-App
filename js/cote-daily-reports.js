// /public/js/cote-daily-reports.js
const gridBody = document.querySelector('#grid tbody');
const qInput = document.querySelector('#q');
const newBtn = document.querySelector('#newBtn');

function fmtDate(iso){ try { return new Date(iso).toLocaleDateString(); } catch { return iso; } }
function uniq(arr){ return Array.from(new Set(arr)); }

async function fetchList(){
  const res = await fetch('/api/daily-report');
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}
async function fetchDetail(id){
  const res = await fetch(`/api/daily-report?id=${id}`);
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

function rowHTML(r){
  return `<tr data-id="${r.id}">
    <td>${fmtDate(r.report_date)}</td>
    <td>${r.bus_driver_only ?? '-'}</td>
    <td>${r.bus_driver_bus ?? '-'}</td>
    <td align="center"><a href="pages/daily-report.html?id=${r.id}" class="btn-link">View</a></td>
    <td align="center"><a href="pages/daily-report.html?id=${r.id}" class="btn-link">Edit</a></td>
    <td align="center"><button class="btn btn-ghost delBtn">Delete</button></td>
    <td align="center"><button class="btn btn-ghost emailBtn">Email</button></td>
  </tr>`;
}

function applyFilter(){
  const term = (qInput.value || '').toLowerCase();
  gridBody.querySelectorAll('tr').forEach(tr => {
    const dateTxt = tr.children[0]?.textContent?.toLowerCase() || '';
    const c1 = tr.children[1]?.textContent || '';
    const c2 = tr.children[2]?.textContent || '';
    const hit = dateTxt.includes(term) || c1.includes(term) || c2.includes(term);
    tr.style.display = hit ? '' : 'none';
  });
}

async function load(){
  gridBody.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
  try{
    const list = await fetchList();
    const detailed = await Promise.all(list.map(async it => {
      try{
        const d = await fetchDetail(it.id);
        const driverOnly = uniq([].concat(...(d.drivers||[]).map(dr => (dr.buses||[]).map(String)))).length;
        const fromEntries = uniq([].concat(...(d.sections||[]).flatMap(s => (s.entries||[]).flatMap(e => (e.buses||[]).map(String))))).length;
        return { ...it, bus_driver_only: driverOnly, bus_driver_bus: fromEntries };
      }catch(err){
        return { ...it, bus_driver_only: '-', bus_driver_bus: '-' };
      }
    }));
    detailed.sort((a,b) => (a.report_date < b.report_date ? 1 : -1));
    gridBody.innerHTML = detailed.map(rowHTML).join('') || '<tr><td colspan="7" class="muted">No reports yet.</td></tr>';
    qInput.addEventListener('input', applyFilter);
  }catch(err){
    gridBody.innerHTML = `<tr><td colspan="7" class="muted">Load failed: ${err.message}</td></tr>`;
  }
}

newBtn?.addEventListener('click', () => {
  const today = new Date(); const yyyy=today.getFullYear(); const mm=String(today.getMonth()+1).padStart(2,'0'); const dd=String(today.getDate()).padStart(2,'0');
  location.href = `pages/daily-report.html?date=${yyyy}-${mm}-${dd}`;
});

load();
