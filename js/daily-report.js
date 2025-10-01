// /js/daily-report.js
// Daily Report UI wired to your existing API schemas.
// Uses:
//   GET /api/drivers  -> [{ id, first_name, last_name, ... }]
//   GET /api/buses    -> [{ id, unit_number, ... }]
//   GET/POST/PUT /api/daily-report (unchanged from previous draft)
// Behavior updates:
// - Header grid:
//    • Driver: <select> built from drivers.first_name + ' ' + last_name
//    • Bus Number(s): multi-select built from buses.unit_number
//    • Status: from /api/workday-status (unchanged)
// - Worksheet:
//    • Removes the old "Buses (allowed)" column.
//    • "Bus Number(s)" column is now EDITABLE via multi-select.
//      Options are the union of bus numbers assigned to drivers in header.
// - Save: each row stores entry.bus_numbers (and mirrors to entry.buses for back-compat).
// - New/Edit flows still supported via ?date=YYYY-MM-DD and ?id=<reportId>.

(function(){
  const bootError = (msg) => {
    const el = document.getElementById('bootError');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = msg;
    console.error(msg);
  };

  const start = () => {
    // State
    let reportState = {
      id: null,
      report_date: null,
      worksheet_id: null,
      header: { other: '' },
      drivers: [], // [{driver_id, name, buses:[string unit_number], status_id}]
      sections: []
    };

    // Master data (mapped to what the UI needs)
    let master = {
      drivers: [], // { id, name }
      buses: []    // { id, number } where number = String(unit_number)
    };

    // DOM helpers
    const $ = (sel, root=document) => root.querySelector(sel);
    const $all = (sel, root=document) => Array.from(root.querySelectorAll(sel));
    const setStatus = (msg) => { const s = $('#statusText'); if (s) s.textContent = msg; };
    const qs = () => { const p=new URLSearchParams(location.search); const o={}; p.forEach((v,k)=>o[k]=v); return o; };

    // Time utils
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
    const hourOptions = (selected) => { let out=''; for(let h=0; h<=23; h++){ const v=String(h).padStart(2,'0'); out+=`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;} return out; };
    const minuteOptions = (selected) => { let out=''; for(let m=0; m<=59; m++){ const v=String(m).padStart(2,'0'); out+=`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;} return out; };

    // Allowed bus list (union of buses assigned above)
    const allowedBusSet = () => {
      const set = new Set();
      reportState.drivers.forEach(d => (d.buses||[]).forEach(b => set.add(String(b))));
      return set;
    };

    // Data loaders
    async function loadWorksheets(){
      const select = $('#worksheetSelect'); const hint = $('#defaultWorksheetHint');
      try{
        const res = await fetch('/api/worksheets');
        if(!res.ok) throw new Error(await res.text());
        const list = await res.json();
        if (!list.length){ select.innerHTML = ''; hint.textContent = 'No worksheets found'; return; }
        select.innerHTML = list.map(ws => `<option value="${ws.id}" ${ws.is_default?'selected':''}>${ws.name}${ws.is_default?' (Default)':''}</option>`).join('');
        const def = list.find(w => w.is_default) || list[0];
        if (!reportState.worksheet_id) reportState.worksheet_id = def?.id || null;
        hint.textContent = def ? `Default: ${def.name}` : '';
      }catch(err){
        select.innerHTML = '';
        hint.textContent = 'Failed to load worksheets';
        console.error(err);
      }
    }

    // NOTE: adapts to your existing endpoints
    async function loadDrivers(){
      const res = await fetch('/api/drivers');
      if(!res.ok) throw new Error(await res.text());
      const rows = await res.json(); // [{id, first_name, last_name, ...}]
      master.drivers = rows.map(r => ({
        id: r.id,
        name: [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
      })).sort((a,b)=>a.name.localeCompare(b.name));
    }

    async function loadBuses(){
      const res = await fetch('/api/buses');
      if(!res.ok) throw new Error(await res.text());
      const rows = await res.json(); // [{id, unit_number, ...}]
      master.buses = rows.map(b => ({
        id: b.id,
        number: String(b.unit_number) // normalize to string
      })).sort((a,b)=>a.number.localeCompare(b.number));
    }

    async function loadStatuses(){
      const res = await fetch('/api/workday-status');
      if(!res.ok) throw new Error(await res.text());
      return await res.json(); // [{id, name, ...}]
    }

    // Header grid
    function driverOptionsHTML(selectedId){
      return master.drivers.map(d => `<option value="${d.id}" ${String(selectedId)===String(d.id)?'selected':''}>${d.name}</option>`).join('');
    }
    function busOptionsHTML(selectedNumbers){
      const sel = new Set((selectedNumbers||[]).map(String));
      return master.buses.map(b => `<option value="${b.number}" ${sel.has(String(b.number))?'selected':''}>${b.number}</option>`).join('');
    }
    function driverRowHTML(statuses, driver){
      return `<tr>
        <td>
          <select class="drv-id">
            ${driverOptionsHTML(driver?.driver_id)}
          </select>
        </td>
        <td>
          <select class="drv-buses" multiple size="3" title="Select buses">
            ${busOptionsHTML(driver?.buses)}
          </select>
        </td>
        <td>
          <select class="drv-status">
            ${statuses.map(s=>`<option value="${s.id}" ${driver?.status_id==s.id?'selected':''}>${s.name}</option>`).join('')}
          </select>
        </td>
        <td><a href="#" class="btn-link-sm delDrv">Delete</a></td>
      </tr>`;
    }

    async function initDriversTable(prefillDrivers){
      const statuses = await loadStatuses();
      const tbody = $('#driversTable tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      if (prefillDrivers && prefillDrivers.length){
        prefillDrivers.forEach(d => tbody.insertAdjacentHTML('beforeend', driverRowHTML(statuses, d)));
      } else {
        tbody.insertAdjacentHTML('beforeend', driverRowHTML(statuses, {}));
      }
      tbody.addEventListener('click', (e)=>{
        if(e.target.classList.contains('delDrv')){
          e.preventDefault();
          e.target.closest('tr').remove();
        }
      });
      $('#addDriverRowBtn')?.addEventListener('click', ()=>{
        tbody.insertAdjacentHTML('beforeend', driverRowHTML(statuses, {}));
      });
    }

    function snapshotDrivers(){
      const rows = $all('#driversTable tbody tr');
      reportState.drivers = rows.map(tr => {
        const id = tr.querySelector('.drv-id')?.value || null;
        const buses = Array.from(tr.querySelector('.drv-buses')?.selectedOptions || []).map(o => String(o.value));
        const status_id = tr.querySelector('.drv-status')?.value || null;
        const driver = master.drivers.find(d => String(d.id)===String(id));
        return {
          driver_id: id ? Number(id) : null,
          name: driver?.name || '',
          buses,
          status_id
        };
      }).filter(d => d.driver_id || (d.buses && d.buses.length));
    }

    // Worksheet rendering
    function busesSelectHTML(preselected){
      const allowed = Array.from(allowedBusSet()).sort((a,b)=>a.localeCompare(b));
      const sel = new Set((preselected||[]).map(String));
      return `<select class="ws-buses" multiple size="3" title="Select from assigned buses only">
        ${allowed.map(n => `<option value="${n}" ${sel.has(String(n))?'selected':''}>${n}</option>`).join('')}
      </select>`;
    }

    function rowInputHTML(r, entry){
      const t24 = to24h(r.pickup_time_default||''); const [hh0,mm0]=(t24||'00:00').split(':');
      const hh = entry?.pickup_time?.split(':')[0] ?? hh0 ?? '00';
      const mm = entry?.pickup_time?.split(':')[1] ?? mm0 ?? '00';
      // Preselect: entry.bus_numbers OR entry.buses OR parse row default
      const pre = entry?.bus_numbers
        || (Array.isArray(entry?.buses) ? entry.buses : null)
        || String(r.bus_number_default||'').split(',').map(s=>s.trim()).filter(Boolean);
      return `<tr>
        <td>${busesSelectHTML(pre)}</td>
        <td contenteditable="true" class="inp-pickup">${entry?.pickup ?? r.pickup_default ?? ''}</td>
        <td contenteditable="true" class="inp-dropoff">${entry?.dropoff ?? r.dropoff_default ?? ''}</td>
        <td>
          <div class="time24">
            <select class="time-select inp-hh">${hourOptions(hh)}</select>
            <span class="time-sep">:</span>
            <select class="time-select inp-mm">${minuteOptions(mm)}</select>
          </div>
        </td>
        <td><input type="text" class="inp-note" value="${entry?.note ?? r.note_default ?? ''}"/></td>
        <td><input type="number" class="inp-dsina" value="${entry?.ds_in_am ?? r.ds_in_am_default ?? 0}"/></td>
        <td><input type="number" class="inp-nsouta" value="${entry?.ns_out_am ?? r.ns_out_am_default ?? 0}"/></td>
        <td><input type="number" class="inp-dsoutp" value="${entry?.ds_out_pm ?? r.ds_out_pm_default ?? 0}"/></td>
        <td><input type="number" class="inp-nsinp" value="${entry?.ns_in_pm ?? r.ns_in_pm_default ?? 0}"/></td>
      </tr>`;
    }

    function sectionInputHTML(section){
      const entries = section.entries || [];
      return `<div class="card" style="margin-bottom:12px;">
        <h4 style="margin-bottom:6px;">${section.section_name || ''}</h4>
        <table class="table compact">
          <colgroup>
            <col style="width:12%"/><col style="width:19%"/><col style="width:19%"/><col style="width:9%"/>
            <col style="width:12%"/><col style="width:8%"/><col style="width:8%"/><col style="width:8%"/><col style="width:8%"/>
          </colgroup>
          <thead>
            <tr>
              <th>Bus Number(s)</th>
              <th>Pickup</th>
              <th>Dropoff</th>
              <th>Pickup Time (24h)</th>
              <th>Note</th>
              <th>D/S IN AM</th>
              <th>N/S OUT AM</th>
              <th>D/S OUT PM</th>
              <th>N/S IN PM</th>
            </tr>
          </thead>
          <tbody>
            ${(section.rows||[]).map((r,i)=>rowInputHTML(r, entries[i])).join('')}
          </tbody>
        </table>
      </div>`;
    }

    async function renderFromTemplate(){
      const id = reportState.worksheet_id;
      const area = $('#worksheetArea');
      if (!id){ area.innerHTML = '<div class="muted">No worksheet selected.</div>'; return; }
      try{
        const res = await fetch(`/api/worksheets?id=${id}`);
        if(!res.ok) throw new Error(await res.text());
        const ws = await res.json();
        reportState.sections = ws.sections || [];
        area.innerHTML = reportState.sections.map(sectionInputHTML).join('');
      }catch(err){
        area.innerHTML = `<div class="muted">Failed to load worksheet: ${err.message}</div>`;
      }
    }

    async function renderFromReport(){
      const area = $('#worksheetArea');
      area.innerHTML = (reportState.sections||[]).map(sectionInputHTML).join('');
    }

    // Header confirm
    $('#confirmHeaderBtn')?.addEventListener('click', async () => {
      reportState.report_date = $('#reportDate')?.value || null;
      reportState.worksheet_id = $('#worksheetSelect')?.value || null;
      reportState.header.other = $('#otherHeader')?.value || '';
      snapshotDrivers();
      setStatus('Header confirmed');
      if (reportState.id){ await renderFromReport(); } else { await renderFromTemplate(); }
    });

    // Worksheet select change
    $('#worksheetSelect')?.addEventListener('change', (e)=>{ reportState.worksheet_id = e.target.value; });

    function snapshotWorksheetInputs(){
      const area = $('#worksheetArea');
      const sectionCards = $all('.card', area);
      sectionCards.forEach((card, si) => {
        const tbody = card.querySelector('tbody'); const rows = $all('tr', tbody);
        const sec = reportState.sections[si];
        sec.entries = rows.map((tr) => {
          const hh = tr.querySelector('.inp-hh')?.value || '00';
          const mm = tr.querySelector('.inp-mm')?.value || '00';
          const busNumbers = Array.from(tr.querySelector('.ws-buses')?.selectedOptions || []).map(o => String(o.value));
          return {
            pickup: tr.querySelector('.inp-pickup')?.innerText?.trim() || '',
            dropoff: tr.querySelector('.inp-dropoff')?.innerText?.trim() || '',
            pickup_time: `${hh}:${mm}`,
            note: tr.querySelector('.inp-note')?.value || '',
            ds_in_am: parseInt(tr.querySelector('.inp-dsina')?.value || '0',10),
            ns_out_am: parseInt(tr.querySelector('.inp-nsouta')?.value || '0',10),
            ds_out_pm: parseInt(tr.querySelector('.inp-dsoutp')?.value || '0',10),
            ns_in_pm: parseInt(tr.querySelector('.inp-nsinp')?.value || '0',10),
            bus_numbers: busNumbers,
            buses: busNumbers // mirror for back-compat if your API expects "buses"
          };
        });
      });
    }

    async function saveReport(submit=false){
      snapshotDrivers();
      snapshotWorksheetInputs();

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

    // Wire save
    $('#saveDraftBtn')?.addEventListener('click', ()=>saveReport(false));
    $('#saveSubmitBtn')?.addEventListener('click', ()=>saveReport(true));

    // Init
    (async function init(){
      try{
        // Preload masters to build selects with your existing API shapes
        await Promise.all([loadDrivers(), loadBuses(), loadWorksheets()]);

        // Init date
        const params = qs();
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth()+1).padStart(2,'0');
        const dd = String(today.getDate()).padStart(2,'0');
        const dateEl = $('#reportDate');
        if (dateEl) dateEl.value = params.date || `${yyyy}-${mm}-${dd}`;

        if (params.id){
          const res = await fetch(`/api/daily-report?id=${params.id}`);
          if (res.ok){
            const r = await res.json();
            reportState = {
              id: r.id,
              report_date: r.report_date,
              worksheet_id: r.worksheet_id,
              header: r.header || { other: '' },
              drivers: r.drivers || [],
              sections: r.sections || []
            };
            if (dateEl) dateEl.value = r.report_date;
            const wsSel = $('#worksheetSelect'); if (wsSel) wsSel.value = String(r.worksheet_id);
            const other = $('#otherHeader'); if (other) other.value = r.header?.other || '';
            await initDriversTable(reportState.drivers);
            await renderFromReport();
            setStatus('Loaded for edit');
          }else{
            await initDriversTable([]);
            setStatus('Failed to load report');
          }
        }else{
          await initDriversTable([]);
        }
      }catch(err){
        bootError('Failed to initialize Daily Report. Check console and API routes.');
        console.error(err);
      }
    })();
  };

  if (document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start, { once:true });
  } else {
    start();
  }
})();
