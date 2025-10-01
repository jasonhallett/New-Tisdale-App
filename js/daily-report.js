// /js/daily-report.js
// Supervisor in header, compact MultiSelect height, smoother scrolling,
// and the previous fixes (phantom panel, 24h time, section totals).
import { MultiSelect } from './controls/multiselect.js';

(function(){
  const bootError = (msg) => {
    const el = document.getElementById('bootError');
    if (!el) return;
    el.style.display = 'block';
    el.textContent = msg;
    console.error(msg);
  };

  // Throttle helper
  const throttle = (fn, wait=100) => {
    let last = 0, t;
    return (...args) => {
      const now = Date.now();
      if (now - last >= wait) {
        last = now; fn(...args);
      } else {
        clearTimeout(t);
        t = setTimeout(()=>{ last = Date.now(); fn(...args); }, wait - (now - last));
      }
    };
  };

  const start = () => {
    let reportState = {
      id: null,
      report_date: null,
      worksheet_id: null,
      header: { other: '', supervisor_id: null },
      drivers: [],
      sections: []
    };

    let master = { drivers: [], buses: [], supervisors: [] };

    const $ = (sel, root=document) => root.querySelector(sel);
    const $all = (sel, root=document) => Array.from(root.querySelectorAll(sel));
    const setStatus = (msg) => { const s = $('#statusText'); if (s) s.textContent = msg; };
    const qs = () => { const p=new URLSearchParams(location.search); const o={}; p.forEach((v,k)=>o[k]=v); return o; };

    function to24h(value){
      if(!value) return '';
      let s = String(value).trim();
      const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
      if(m24){
        let h = parseInt(m24[1],10), m=parseInt(m24[2],10);
        if(Number.isNaN(h) || Number.isNaN(m)) return '';
        h = (h+24)%24; m = (m+60)%60; return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      }
      const m12 = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
      if(m12){
        let h = parseInt(m12[1],10), m=parseInt(m12[2],10); const ap=m12[3].toUpperCase();
        if(ap==='AM'){ if(h===12) h=0; } else { if(h!==12) h+=12; }
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      }
      const mh = s.match(/^(\d{1,2})$/);
      if(mh){ let h=parseInt(mh[1],10); h=(h+24)%24; return `${String(h).padStart(2,'0')}:00`; }
      return s;
    }
    const hourOptions = (selected) => { let out=''; for(let h=0; h<=23; h++){ const v=String(h).padStart(2,'0'); out+=`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;} return out; };
    const minuteOptions = (selected) => { let out=''; for(let m=0; m<=59; m++){ const v=String(m).padStart(2,'0'); out+=`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;} return out; };

    const allowedBusSet = () => { const set = new Set(); reportState.drivers.forEach(d => (d.buses||[]).forEach(b => set.add(String(b)))); return set; };

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
    async function loadDrivers(){
      const res = await fetch('/api/drivers');
      if(!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      master.drivers = rows.map(r => ({ id:r.id, name:[r.first_name, r.last_name].filter(Boolean).join(' ').trim() }))
                           .sort((a,b)=>a.name.localeCompare(b.name));
    }
    async function loadBuses(){
      const res = await fetch('/api/buses');
      if(!res.ok) throw new Error(await res.text());
      const rows = await res.json();
      master.buses = rows.map(b => ({ id:b.id, number:String(b.unit_number) }))
                         .sort((a,b)=>a.number.localeCompare(b.number));
    }
    async function loadSupervisors(){
      try{
        const res = await fetch('/api/supervisors');
        if(!res.ok) throw new Error(await res.text());
        const rows = await res.json();
        master.supervisors = rows.map(s => ({
          id: s.id,
          name: s.name || [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || 'Supervisor'
        })).sort((a,b)=>a.name.localeCompare(b.name));
        const sel = $('#supervisorSelect');
        if (sel) sel.innerHTML = `<option value="">— Select —</option>` + master.supervisors.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
      }catch(err){
        const sel = $('#supervisorSelect'); if (sel) sel.innerHTML = `<option value="">(none)</option>`;
        console.warn('supervisors load failed', err);
      }
    }
    async function loadStatuses(){
      const res = await fetch('/api/workday-status');
      if(!res.ok) throw new Error(await res.text());
      return await res.json();
    }

    // ----- MultiSelect helpers -----
    function closeMS(ms){
      try{ ms?.close?.(); }catch{}
      const root = ms?.root || null;
      if (root){
        const panel = root.querySelector?.('.ms-panel');
        if (panel) panel.setAttribute('aria-hidden','true');
      }
    }

    function buildHeaderBusMulti(container, preselected){
      const opts = master.buses.map(b => ({ value:b.number, label:b.number }));
      const ms = new MultiSelect(container, { options: opts, selected: preselected||[], placeholder:'Bus #' });
      closeMS(ms);
      return ms;
    }
    function buildWorksheetBusMulti(container, preselected){
      const allowed = Array.from(allowedBusSet()).sort((a,b)=>a.localeCompare(b));
      const opts = allowed.map(n => ({ value:n, label:n }));
      const ms = new MultiSelect(container, { options: opts, selected: preselected||[], placeholder:'Bus #' });
      closeMS(ms);
      return ms;
    }

    // Close any open panels during scroll to avoid reflow jank
    const closeAllPanelsOnScroll = throttle(() => {
      document.querySelectorAll('.ms-panel').forEach(p => {
        p.setAttribute('aria-hidden','true');
      });
    }, 150);
    window.addEventListener('scroll', closeAllPanelsOnScroll, { passive: true });

    // Header grid
    function driverOptionsHTML(selectedId){
      return master.drivers.map(d => `<option value="${d.id}" ${String(selectedId)===String(d.id)?'selected':''}>${d.name}</option>`).join('');
    }
    function driverRowHTML(statuses, driver){
      return `<tr>
        <td>
          <select class="drv-id">${driverOptionsHTML(driver?.driver_id)}</select>
        </td>
        <td>
          <div class="drv-buses" data-ms></div>
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
      // hydrate MultiSelects
      $all('.drv-buses', tbody).forEach((cell, idx) => {
        const pre = prefillDrivers?.[idx]?.buses || [];
        const ms = buildHeaderBusMulti(cell, pre);
        cell._ms = ms;
      });

      tbody.addEventListener('click', (e)=>{
        if(e.target.classList.contains('delDrv')){
          e.preventDefault();
          e.target.closest('tr').remove();
        }
      });
      $('#addDriverRowBtn')?.addEventListener('click', ()=>{
        tbody.insertAdjacentHTML('beforeend', driverRowHTML(statuses, {}));
        const cell = tbody.lastElementChild.querySelector('.drv-buses');
        cell._ms = buildHeaderBusMulti(cell, []);
      });
    }

    function snapshotDrivers(){
      const rows = $all('#driversTable tbody tr');
      reportState.drivers = rows.map(tr => {
        const id = tr.querySelector('.drv-id')?.value || null;
        const status_id = tr.querySelector('.drv-status')?.value || null;
        const driver = master.drivers.find(d => String(d.id)===String(id));
        const buses = tr.querySelector('.drv-buses')._ms?.get() || [];
        return {
          driver_id: id ? Number(id) : null,
          name: driver?.name || '',
          buses,
          status_id
        };
      }).filter(d => d.driver_id || (d.buses && d.buses.length));
    }

    // ===== Totals helpers (per section) =====
    function computeSectionTotals(card){
      const rows = $all('tbody tr', card);
      let s1=0, s2=0, s3=0, s4=0;
      rows.forEach(tr => {
        const v1 = parseInt(tr.querySelector('.inp-dsina')?.value || '0', 10) || 0;
        const v2 = parseInt(tr.querySelector('.inp-nsouta')?.value || '0', 10) || 0;
        const v3 = parseInt(tr.querySelector('.inp-dsoutp')?.value || '0', 10) || 0;
        const v4 = parseInt(tr.querySelector('.inp-nsinp')?.value || '0', 10) || 0;
        s1 += v1; s2 += v2; s3 += v3; s4 += v4;
      });
      const tds = {
        dsin: card.querySelector('.totals-dsina'),
        nsout: card.querySelector('.totals-nsouta'),
        dsout: card.querySelector('.totals-dsoutp'),
        nsin: card.querySelector('.totals-nsinp'),
        grand: card.querySelector('.totals-grand')
      };
      if (tds.dsin)  tds.dsin.textContent  = String(s1);
      if (tds.nsout) tds.nsout.textContent = String(s2);
      if (tds.dsout) tds.dsout.textContent = String(s3);
      if (tds.nsin)  tds.nsin.textContent  = String(s4);
      if (tds.grand) tds.grand.textContent = String(s1+s2+s3+s4);
    }

    function bindSectionTotals(card){
      computeSectionTotals(card);
      card.addEventListener('input', (e) => {
        const t = e.target;
        if (t.classList && (t.classList.contains('inp-dsina') || t.classList.contains('inp-nsouta') || t.classList.contains('inp-dsoutp') || t.classList.contains('inp-nsinp'))){
          computeSectionTotals(card);
        }
      });
    }

    // Worksheet rendering
    function rowInputHTML(r, entry){
      const t24 = to24h(r.pickup_time_default||''); const [hh0,mm0]=(t24||'00:00').split(':');
      const hh = entry?.pickup_time?.split(':')[0] ?? hh0 ?? '00';
      const mm = entry?.pickup_time?.split(':')[1] ?? mm0 ?? '00';
      const pre = entry?.bus_numbers || (Array.isArray(entry?.buses)?entry.buses:null) || String(r.bus_number_default||'').split(',').map(s=>s.trim()).filter(Boolean);
      return `<tr>
        <td><div class="ws-buses" data-ms></div></td>
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
      const secName = section.section_name || 'Section';
      return `<div class="card" style="margin-bottom:12px;">
        <h4 style="margin-bottom:6px;">${secName}</h4>
        <table class="table compact">
          <colgroup>
            <col style="width:16%"/><col style="width:19%"/><col style="width:19%"/><col style="width:9%"/>
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
          <tfoot>
            <tr class="row-totals">
              <td colspan="5" class="totals-label"><strong>Totals</strong></td>
              <td class="totals-dsina">0</td>
              <td class="totals-nsouta">0</td>
              <td class="totals-dsoutp">0</td>
              <td class="totals-nsinp">0</td>
            </tr>
            <tr class="row-grand">
              <td colspan="8" class="totals-grand-label"><strong>${secName} Grand Total</strong></td>
              <td class="totals-grand">0</td>
            </tr>
          </tfoot>
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
        let secIdx=0;
        $all('.card', area).forEach((card) => {
          const tbody = card.querySelector('tbody');
          const rows = $all('tr', tbody);
          rows.forEach((tr, i) => {
            const cell = tr.querySelector('.ws-buses');
            const entries = (reportState.sections[secIdx]?.entries)||[];
            const entry = entries[i] || {};
            const pre = entry.bus_numbers || entry.buses || [];
            const ms = buildWorksheetBusMulti(cell, pre);
            cell._ms = ms;
            closeMS(ms);
          });
          bindSectionTotals(card);
          secIdx++;
        });
      }catch(err){
        area.innerHTML = `<div class="muted">Failed to load worksheet: ${err.message}</div>`;
      }
    }

    async function renderFromReport(){
      const area = $('#worksheetArea');
      area.innerHTML = (reportState.sections||[]).map(sectionInputHTML).join('');
      let secIdx=0;
      $all('.card', area).forEach((card) => {
        const tbody = card.querySelector('tbody');
        const rows = $all('tr', tbody);
        rows.forEach((tr, i) => {
          const cell = tr.querySelector('.ws-buses');
          const entries = (reportState.sections[secIdx]?.entries)||[];
          const entry = entries[i] || {};
          const pre = entry.bus_numbers || entry.buses || [];
          const ms = buildWorksheetBusMulti(cell, pre);
          cell._ms = ms;
          closeMS(ms);
        });
        bindSectionTotals(card);
        secIdx++;
      });
    }

    // Header confirm (kept as-is)
    $('#confirmHeaderBtn')?.addEventListener('click', async () => {
      reportState.report_date = $('#reportDate')?.value || null;
      reportState.worksheet_id = $('#worksheetSelect')?.value || null;
      reportState.header.other = $('#otherHeader')?.value || '';
      reportState.header.supervisor_id = $('#supervisorSelect')?.value || null;
      snapshotDrivers();
      setStatus('Header confirmed');
      if (reportState.id){ await renderFromReport(); } else { await renderFromTemplate(); }
    });

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
          const cell = tr.querySelector('.ws-buses');
          const busNumbers = cell?._ms?.get() || [];
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
            buses: busNumbers
          };
        });
      });
    }

    function normalizeStateForSave(){
      const raw = $('#reportDate')?.value || reportState.report_date || '';
      reportState.report_date = String(raw).slice(0,10);
      reportState.worksheet_id = $('#worksheetSelect')?.value || reportState.worksheet_id;
      reportState.header = typeof reportState.header === 'string' ? safeParse(reportState.header, {other:'', supervisor_id:null}) : (reportState.header || {other:'', supervisor_id:null});
      reportState.drivers = Array.isArray(reportState.drivers) ? reportState.drivers
                           : (typeof reportState.drivers === 'string' ? safeParse(reportState.drivers, []) : []);
      reportState.sections = Array.isArray(reportState.sections) ? reportState.sections
                           : (typeof reportState.sections === 'string' ? safeParse(reportState.sections, []) : []);
    }
    function safeParse(s, fallback){
      try{ const v = JSON.parse(s); return v==null?fallback:v; }catch{ return fallback; }
    }

    async function saveReport(submit=false){
      snapshotDrivers();
      snapshotWorksheetInputs();
      normalizeStateForSave();

      if (!reportState.report_date){ alert('Missing Date'); return; }
      if (!reportState.worksheet_id){ alert('Missing Worksheet'); return; }

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
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const msg = await res.text().catch(()=>String(res.status));
        alert(msg);
        return;
      }
      const out = await res.json();
      reportState.id = out.id;
      setStatus(submit ? 'Submitted' : 'Saved');
      alert(submit ? 'Daily Report submitted ✅' : 'Daily Report saved ✅');
    }

    $('#saveDraftBtn')?.addEventListener('click', ()=>saveReport(false));
    $('#saveSubmitBtn')?.addEventListener('click', ()=>saveReport(true));

    (async function init(){
      try{
        await Promise.all([loadDrivers(), loadBuses(), loadWorksheets(), loadSupervisors()]);
        const params = qs();
        const today = new Date(); const yyyy=today.getFullYear(); const mm=String(today.getMonth()+1).padStart(2,'0'); const dd=String(today.getDate()).padStart(2,'0');
        const dateEl = $('#reportDate'); 
        if (dateEl) dateEl.value = params.date || `${yyyy}-${mm}-${dd}`;

        if (params.id){
          const res = await fetch(`/api/daily-report?id=${params.id}`);
          if (res.ok){
            const r = await res.json();
            reportState = { id:r.id, report_date:r.report_date, worksheet_id:r.worksheet_id, header:r.header||{other:'', supervisor_id:null}, drivers:r.drivers||[], sections:r.sections||[] };
            if (dateEl) dateEl.value = String(r.report_date || '').slice(0,10);
            const wsSel = $('#worksheetSelect'); if (wsSel) wsSel.value = String(r.worksheet_id);
            const supSel = $('#supervisorSelect'); if (supSel) supSel.value = String(r.header?.supervisor_id || '');
            const other = $('#otherHeader'); if (other) other.value = r.header?.other || '';
            await initDriversTable(reportState.drivers);
            await renderFromReport();
            setStatus('Loaded for edit');
          }else{
            await initDriversTable([]);
            await renderFromTemplate();
            setStatus('Failed to load report');
          }
        }else{
          await initDriversTable([]);
          await renderFromTemplate();
        }

        // Final safety: close any panels that might have opened during hydration
        document.querySelectorAll('.ms-panel').forEach(p => p.setAttribute('aria-hidden','true'));
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
