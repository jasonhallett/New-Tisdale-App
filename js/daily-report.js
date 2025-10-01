// /public/js/daily-report.js
let reportState = {
  id: null,
  report_date: null,
  worksheet_id: null,
  header: { other: '' },
  drivers: [],
  sections: []
};

function $(sel, root=document){ return root.querySelector(sel); }
function $all(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }
function setStatus(msg){ $('#statusText').textContent = msg; }

function to24h(value){
  if(!value) return '';
  let s = String(value).trim();
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if(m24){
    let h = parseInt(m24[1],10);
    let m = parseInt(m24[2],10);
    if(Number.isNaN(h) || Number.isNaN(m)) return '';
    h = (h+24)%24;
    m = Math.min(Math.max(m,0),59);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if(m12){
    let h = parseInt(m12[1],10);
    let m = parseInt(m12[2],10);
    const ap = m12[3].toUpperCase();
    if(ap === 'AM'){ if(h===12) h = 0; } else { if(h!==12) h += 12; }
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
  }
  const mh = s.match(/^(\d{1,2})$/);
  if(mh){
    let h = parseInt(mh[1],10);
    h = (h+24)%24;
    return `${String(h).padStart(2,'0')}:00`;
  }
  return s;
}
function hourOptions(selected){ let out=''; for(let h=0; h<=23; h++){ const v=String(h).padStart(2,'0'); out+=`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;} return out;}
function minuteOptions(selected){ let out=''; for(let m=0; m<=59; m++){ const v=String(m).padStart(2,'0'); out+=`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;} return out;}

function tokenBusList(str){ return (str||'').split(',').map(s=>s.trim()).filter(Boolean); }
function allowedBusSet(){
  const set = new Set();
  reportState.drivers.forEach(d => (d.buses||[]).forEach(b => set.add(b)));
  return set;
}
function validateBusTokens(inputEl, allowed){
  const tokens = tokenBusList(inputEl.value);
  const bad = tokens.filter(t => !allowed.has(t));
  if (bad.length) inputEl.classList.add('invalid'); else inputEl.classList.remove('invalid');
  inputEl.title = bad.length ? `Not allowed: ${bad.join(', ')}` : '';
  return bad.length === 0;
}

async function loadWorksheets(){
  const res = await fetch('/api/worksheets');
  if(!res.ok) throw new Error(await res.text());
  const list = await res.json();
  const select = $('#worksheetSelect');
  select.innerHTML = list.map(ws => `<option value="${ws.id}" ${ws.is_default?'selected':''}>${ws.name}${ws.is_default?' (Default)':''}</option>`).join('');
  const def = list.find(w => w.is_default) || list[0];
  reportState.worksheet_id = def?.id || null;
  $('#defaultWorksheetHint').textContent = def ? `Default: ${def.name}` : 'No worksheets found';
}
async function loadStatuses(){
  const res = await fetch('/api/workday-status');
  if(!res.ok) throw new Error(await res.text());
  return await res.json();
}

function driverRowHTML(statuses){
  const options = statuses.map(s=>`<option value="${s.id}">${s.name}</option>`).join('');
  return `<tr>
    <td><input type="text" class="drv-name" placeholder="Driver name"/></td>
    <td><input type="text" class="drv-buses" placeholder="e.g., 12, 34"/></td>
    <td><select class="drv-status">${options}</select></td>
    <td><a href="#" class="btn-link-sm delDrv">Delete</a></td>
  </tr>`;
}
async function initDriversTable(){
  const statuses = await loadStatuses();
  const tbody = $('#driversTable tbody');
  tbody.innerHTML = '';
  tbody.insertAdjacentHTML('beforeend', driverRowHTML(statuses));
  tbody.addEventListener('click', (e)=>{
    if(e.target.classList.contains('delDrv')){
      e.preventDefault(); e.target.closest('tr').remove();
    }
  });
  $('#addDriverRowBtn').addEventListener('click', ()=>{
    tbody.insertAdjacentHTML('beforeend', driverRowHTML(statuses));
  });
}
function snapshotDrivers(){
  const rows = $all('#driversTable tbody tr');
  reportState.drivers = rows.map(tr => ({
    name: tr.querySelector('.drv-name')?.value?.trim() || '',
    buses: tokenBusList(tr.querySelector('.drv-buses')?.value || ''),
    status_id: tr.querySelector('.drv-status')?.value || null
  })).filter(d => d.name || (d.buses && d.buses.length));
}

function rowInputHTML(r){
  const t24 = to24h(r.pickup_time_default||''); const [hh,mm]=(t24||'00:00').split(':');
  return `<tr>
    <td>${r.bus_number_default ?? ''}</td>
    <td contenteditable="true" class="inp-pickup">${r.pickup_default ?? ''}</td>
    <td contenteditable="true" class="inp-dropoff">${r.dropoff_default ?? ''}</td>
    <td>
      <div class="time24">
        <select class="time-select inp-hh">${hourOptions(hh||'00')}</select>
        <span class="time-sep">:</span>
        <select class="time-select inp-mm">${minuteOptions(mm||'00')}</select>
      </div>
    </td>
    <td><input type="text" class="inp-note" value="${r.note_default??''}"/></td>
    <td><input type="number" class="inp-dsina" value="${r.ds_in_am_default??0}"/></td>
    <td><input type="number" class="inp-nsouta" value="${r.ns_out_am_default??0}"/></td>
    <td><input type="number" class="inp-dsoutp" value="${r.ds_out_pm_default??0}"/></td>
    <td><input type="number" class="inp-nsinp" value="${r.ns_in_pm_default??0}"/></td>
    <td><input type="text" class="inp-buses" placeholder="Allowed buses only"/></td>
  </tr>`;
}
function sectionInputHTML(section){
  return `<div class="card" style="margin-bottom:12px;">
    <h4 style="margin-bottom:6px;">${section.section_name || ''}</h4>
    <table class="table compact">
      <colgroup>
        <col style="width:9%"/><col style="width:17%"/><col style="width:17%"/><col style="width:9%"/>
        <col style="width:12%"/><col style="width:8%"/><col style="width:8%"/><col style="width:8%"/><col style="width:8%"/><col style="width:8%"/>
      </colgroup>
      <thead>
        <tr><th>Bus Number(s)</th><th>Pickup</th><th>Dropoff</th><th>Pickup Time (24h)</th><th>Note</th>
            <th>D/S IN AM</th><th>N/S OUT AM</th><th>D/S OUT PM</th><th>N/S IN PM</th><th>Buses (allowed)</th></tr>
      </thead>
      <tbody>${(section.rows||[]).map(rowInputHTML).join('')}</tbody>
    </table>
  </div>`;
}
async function loadWorksheetTemplateAndRender(){
  const id = reportState.worksheet_id;
  if (!id) { $('#worksheetArea').innerHTML = '<div class="muted">No worksheet selected.</div>'; return; }
  const res = await fetch(`/api/worksheets?id=${id}`);
  if(!res.ok){ $('#worksheetArea').innerHTML = `<div class="muted">Load failed: ${await res.text()}</div>`; return; }
  const ws = await res.json();
  reportState.sections = ws.sections || [];
  const area = $('#worksheetArea');
  area.innerHTML = reportState.sections.map(sectionInputHTML).join('');
  $all('.inp-buses', area).forEach(inp => {
    inp.addEventListener('input', () => validateBusTokens(inp, allowedBusSet()));
  });
}

// Confirm header
$('#confirmHeaderBtn').addEventListener('click', async () => {
  reportState.report_date = $('#reportDate').value || null;
  reportState.worksheet_id = $('#worksheetSelect').value || null;
  reportState.header.other = $('#otherHeader').value || '';
  snapshotDrivers();
  setStatus('Header confirmed');
  await loadWorksheetTemplateAndRender();
});

$('#worksheetSelect').addEventListener('change', (e)=>{ reportState.worksheet_id = e.target.value; });

function snapshotWorksheetInputs(){
  const area = $('#worksheetArea');
  const sectionCards = $all('.card', area);
  sectionCards.forEach((card, si) => {
    const tbody = card.querySelector('tbody'); const rows = $all('tr', tbody);
    const sec = reportState.sections[si];
    sec.entries = rows.map((tr, ri) => {
      const hh = tr.querySelector('.inp-hh')?.value || '00';
      const mm = tr.querySelector('.inp-mm')?.value || '00';
      return {
        pickup: tr.querySelector('.inp-pickup')?.innerText?.trim() || '',
        dropoff: tr.querySelector('.inp-dropoff')?.innerText?.trim() || '',
        pickup_time: `${hh}:${mm}`,
        note: tr.querySelector('.inp-note')?.value || '',
        ds_in_am: parseInt(tr.querySelector('.inp-dsina')?.value || '0',10),
        ns_out_am: parseInt(tr.querySelector('.inp-nsouta')?.value || '0',10),
        ds_out_pm: parseInt(tr.querySelector('.inp-dsoutp')?.value || '0',10),
        ns_in_pm: parseInt(tr.querySelector('.inp-nsinp')?.value || '0',10),
        buses: tokenBusList(tr.querySelector('.inp-buses')?.value || '')
      };
    });
  });
}

async function saveReport(submit=false){
  snapshotDrivers();
  snapshotWorksheetInputs();
  const allowed = allowedBusSet();
  const badInputs = $all('.inp-buses').filter(inp => !validateBusTokens(inp, allowed));
  if (badInputs.length){ alert('One or more bus fields contain unassigned bus numbers.'); return; }

  const payload = {
    id: reportState.id,
    report_date: reportState.report_date,
    worksheet_id: reportState.worksheet_id,
    header: reportState.header,
    drivers: reportState.drivers,
    sections: reportState.sections,
    submitted: !!submit
  };
  const method = reportState.id ? 'PUT' : 'POST';
  const res = await fetch('/api/daily-report', {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  if(!res.ok){ alert(await res.text()); return; }
  const out = await res.json();
  reportState.id = out.id;
  setStatus(submit ? 'Submitted' : 'Saved');
  alert(submit ? 'Daily Report submitted ✅' : 'Daily Report saved ✅');
}

// init
(async function init(){
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth()+1).padStart(2,'0');
  const dd = String(today.getDate()).padStart(2,'0');
  $('#reportDate').value = `${yyyy}-${mm}-${dd}`;
  await loadWorksheets();
  await initDriversTable();
  $('#saveDraftBtn').addEventListener('click', ()=>saveReport(false));
  $('#saveSubmitBtn').addEventListener('click', ()=>saveReport(true));
})();
