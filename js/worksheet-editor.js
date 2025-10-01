// /js/worksheet-editor.js
// Adds:
//  - Drag handles for sections (≡ in header) and rows (≡ in Action column)
//  - Section drag-to-reorder + copy/delete
//  - Row drag-to-reorder (handle-driven), copy/delete
// Keeps:
//  - Strict 24h time selects (HH/MM)
//  - Locked columns (Bus #, D/S & N/S)
//  - “Note” column persisted as note_default
//  - Compact table styling + column widths

// ===== Inline compact + DnD styles =====
(function ensureCompactStyles(){
  const id = 'worksheet-editor-compact-styles';
  if (document.getElementById(id)) return;
  const css = `
    table.compact { border-collapse: collapse; }
    table.compact th, table.compact td { padding: 6px 8px; font-size: 14px; line-height: 1.2; }

    td.locked { background: #f3f4f6; color: #334155; cursor: not-allowed; user-select: none; }
    td.locked:focus { outline: none; box-shadow: none; }

    .time24 { display:inline-flex; align-items:center; gap:2px; }
    .time-select { width:58px; min-width:54px; padding:4px 6px; font:inherit; }
    .time-sep { opacity:.6; }

    .section.card { padding: 10px 12px; }
    .section-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px !important; gap:10px; }
    .section-actions { display:flex; gap:8px; align-items:center; }
    .btn-ghost-danger { color:#dc2626; }
    .btn-ghost-danger:hover { color:#b91c1c; }

    /* Row drag visuals */
    tbody tr.dragging { opacity: .45; }
    tbody tr.drop-before { box-shadow: 0 -2px 0 0 #3b82f6 inset; }
    tbody tr.drop-after  { box-shadow: 0  2px 0 0 #3b82f6 inset; }

    /* Section drag visuals */
    .section.dragging-sec { opacity:.6; }
    .section.drop-before-sec { outline: 2px solid #3b82f6; outline-offset: -2px; box-shadow: 0 -2px 0 0 #3b82f6 inset; }
    .section.drop-after-sec  { outline: 2px solid #3b82f6; outline-offset: -2px; box-shadow: 0  2px 0 0 #3b82f6 inset; }

    /* Action links */
    .btn-link-sm { font-size: 12px; text-decoration: underline; cursor: pointer; }
    .action-cell { display:flex; gap:10px; align-items:center; justify-content:flex-start; }

    /* Drag handles */
    .row-handle, .section-handle {
      display:inline-flex; align-items:center; justify-content:center;
      width:22px; height:22px; border-radius:6px;
      font-size:14px; line-height:1; user-select:none;
      cursor:grab; color:#64748b; background:#f1f5f9;
    }
    .row-handle:hover, .section-handle:hover { background:#e2e8f0; color:#334155; }
    .row-handle:active, .section-handle:active { cursor:grabbing; }
  `;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.appendChild(style);
})();

// ===== State =====
let currentWorksheetId = null;
let worksheetData = { id: null, name: '', sections: [] };

// Track row drag state
const dragRow = { srcSecIdx: null, srcRowIdx: null, overTR: null, overPos: null }; // 'before' | 'after'
// Track section drag state
const dragSec = { srcSecIdx: null, overSecDiv: null, overPos: null }; // 'before' | 'after'

// ===== Modal helpers =====
function openModal(id, focusId) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('open');
  if (focusId) setTimeout(() => document.getElementById(focusId)?.focus(), 30);
}
function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('open');
}
['newWorksheetModal','newSectionModal'].forEach(mid => {
  const modal = document.getElementById(mid);
  modal?.addEventListener('click', (e) => {
    if (e.target.dataset.close === 'true' || e.target.classList.contains('backdrop')) closeModal(mid);
  });
});

// ===== Utilities =====
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
function hhmmParts(hhmm){
  const x = to24h(hhmm || '') || '00:00';
  const [h,m] = x.split(':');
  return { h: h.padStart(2,'0'), m: m.padStart(2,'0') };
}
function makeHourOptions(selected){
  let out = '';
  for(let h=0; h<=23; h++){
    const v = String(h).padStart(2,'0');
    out += `<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;
  }
  return out;
}
function makeMinuteOptions(selected){
  let out = '';
  for(let m=0; m<=59; m++){
    const v = String(m).padStart(2,'0');
    out += `<option value="${v}" ${v===selected?'selected':''}>${v}</option>`;
  }
  return out;
}
function getTimeFromCell(td){
  const hSel = td.querySelector('.time-hh');
  const mSel = td.querySelector('.time-mm');
  if (!hSel || !mSel) return '';
  const h = (hSel.value || '00').padStart(2,'0');
  const m = (mSel.value || '00').padStart(2,'0');
  return `${h}:${m}`;
}

// Build payload from current DOM (reflects current visual order)
function buildPayloadFromDOM() {
  const select = document.getElementById('worksheetSelect');
  const selectedOption = select?.options?.[select.selectedIndex];
  const nameFromSelect = selectedOption ? selectedOption.textContent.replace(' (Default)','') : (worksheetData.name || 'Untitled');

  const sections = [];
  document.querySelectorAll('#sectionsContainer .section').forEach((secDiv, si) => {
    const section_name = secDiv.querySelector('.section-title')?.value?.trim() || `Section ${si+1}`;
    const rows = [];
    const trs = secDiv.querySelectorAll('tbody tr');
    trs.forEach((tr, ri) => {
      const tds = tr.querySelectorAll('td');
      rows.push({
        id: tr.dataset.id || `new-${Date.now()}-${ri}`,
        bus_number_default: tds[0]?.innerText.trim() || '',
        pickup_default:     tds[1]?.innerText.trim() || '',
        dropoff_default:    tds[2]?.innerText.trim() || '',
        pickup_time_default: getTimeFromCell(tds[3]),
        note_default:       tds[4]?.innerText.trim() || '',
        ds_in_am_default:   parseInt(tds[5]?.innerText.trim() || '0', 10),
        ns_out_am_default:  parseInt(tds[6]?.innerText.trim() || '0', 10),
        ds_out_pm_default:  parseInt(tds[7]?.innerText.trim() || '0', 10),
        ns_in_pm_default:   parseInt(tds[8]?.innerText.trim() || '0', 10),
        position: ri
      });
    });
    sections.push({ id: secDiv.dataset.id || `new-${Date.now()}-${si}`, section_name, position: si, rows });
  });

  return { id: currentWorksheetId, name: nameFromSelect, sections };
}

// ===== Loaders =====
async function loadWorksheets() {
  const res = await fetch('/api/worksheets');
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GET /api/worksheets failed: ${t}`);
  }
  const worksheets = await res.json();
  const select = document.getElementById('worksheetSelect');

  select.innerHTML = worksheets.map(ws =>
    `<option value="${ws.id}" ${ws.is_default ? 'selected' : ''}>
       ${ws.name}${ws.is_default ? ' (Default)' : ''}
     </option>`).join('');

  if (!worksheets.length) {
    openModal('newWorksheetModal', 'newWorksheetName');
    return;
  }

  currentWorksheetId = worksheets.find(w => w.is_default)?.id || worksheets[0].id;
  select.value = currentWorksheetId;
  await loadWorksheet(currentWorksheetId);
}

async function loadWorksheet(id) {
  const res = await fetch(`/api/worksheets?id=${id}`);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`GET /api/worksheets?id=${id} failed: ${t}`);
  }
  worksheetData = await res.json();
  renderSections();
}

// ===== Render =====
function rowHTML(r){
  const t24 = to24h(r.pickup_time_default ?? '');
  const { h, m } = hhmmParts(t24);
  return `
    <tr data-id="${r.id || ''}">
      <td class="locked" tabindex="-1">${r.bus_number_default ?? ''}</td>
      <td contenteditable="true">${r.pickup_default ?? ''}</td>
      <td contenteditable="true">${r.dropoff_default ?? ''}</td>
      <td>
        <div class="time24">
          <select class="time-select time-hh" aria-label="Hour (00-23)">${makeHourOptions(h)}</select>
          <span class="time-sep">:</span>
          <select class="time-select time-mm" aria-label="Minute (00-59)">${makeMinuteOptions(m)}</select>
        </div>
      </td>
      <td contenteditable="true">${r.note_default ?? ''}</td>
      <td class="locked" tabindex="-1">${r.ds_in_am_default ?? 0}</td>
      <td class="locked" tabindex="-1">${r.ns_out_am_default ?? 0}</td>
      <td class="locked" tabindex="-1">${r.ds_out_pm_default ?? 0}</td>
      <td class="locked" tabindex="-1">${r.ns_in_pm_default ?? 0}</td>
      <td class="action-cell">
        <span class="row-handle" title="Drag row" draggable="true" aria-label="Drag row">≡</span>
        <a href="#" class="btn-link-sm copyRowBtn" title="Copy row">Copy</a>
        <a href="#" class="btn-link-sm deleteRowBtn" title="Delete row">Delete</a>
      </td>
    </tr>`;
}

function sectionHTML(section){
  return `
    <div class="section card" data-id="${section.id || ''}">
      <div class="section-header">
        <input class="section-title" value="${section.section_name || ''}" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px;"/>
        <div class="section-actions">
          <span class="section-handle" title="Drag section" draggable="true" aria-label="Drag section">≡</span>
          <button class="btn btn-ghost addRowBtn">+ Add Row</button>
          <button class="btn btn-ghost copySectionBtn" title="Copy this section">Copy Section</button>
          <button class="btn btn-ghost btn-ghost-danger deleteSectionBtn" title="Delete this section">Delete Section</button>
        </div>
      </div>
      <table class="table compact w-full">
        <colgroup>
          <col style="width:9%"/>    <!-- Bus Number(s) -->
          <col style="width:17%"/>   <!-- Pickup -->
          <col style="width:17%"/>   <!-- Dropoff -->
          <col style="width:9%"/>    <!-- Time -->
          <col style="width:12%"/>   <!-- Note -->
          <col style="width:8%"/>    <!-- D/S IN AM -->
          <col style="width:8%"/>    <!-- N/S OUT AM -->
          <col style="width:8%"/>    <!-- D/S OUT PM -->
          <col style="width:8%"/>    <!-- N/S IN PM -->
          <col style="width:4%"/>    <!-- Action -->
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
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${(section.rows || []).map(rowHTML).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSections() {
  const container = document.getElementById('sectionsContainer');
  container.innerHTML = '';

  if (!worksheetData || !Array.isArray(worksheetData.sections)) {
    worksheetData = { id: currentWorksheetId, name: worksheetData?.name || '', sections: [] };
  }

  worksheetData.sections.forEach((section) => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = sectionHTML(section);
    container.appendChild(wrapper.firstElementChild);
  });
}

// ===== Events =====

// New Worksheet modal
document.getElementById('newWorksheetBtn').addEventListener('click', () => openModal('newWorksheetModal', 'newWorksheetName'));
document.getElementById('cancelNewWorksheet').addEventListener('click', () => closeModal('newWorksheetModal'));
document.getElementById('confirmNewWorksheet').addEventListener('click', async () => {
  const name = document.getElementById('newWorksheetName').value.trim();
  if (!name) return alert('Enter a name');
  const res = await fetch('/api/worksheets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  if (!res.ok) { alert(`Create failed: ${await res.text()}`); return; }
  const newWs = await res.json();
  closeModal('newWorksheetModal');
  await loadWorksheets();
  document.getElementById('worksheetSelect').value = newWs.id;
  currentWorksheetId = newWs.id;
  await loadWorksheet(currentWorksheetId);
});

// New Section modal
document.getElementById('addSectionBtn').addEventListener('click', () => openModal('newSectionModal', 'newSectionName'));
document.getElementById('cancelNewSection').addEventListener('click', () => closeModal('newSectionModal'));
document.getElementById('confirmNewSection').addEventListener('click', () => {
  const name = document.getElementById('newSectionName').value.trim();
  if (!name) return alert('Enter a section name');
  const payload = buildPayloadFromDOM();
  payload.sections.push({ id: `new-${Date.now()}`, section_name: name, position: payload.sections.length, rows: [] });
  worksheetData = { ...worksheetData, sections: payload.sections };
  closeModal('newSectionModal');
  renderSections();
});

// Sections container shared handlers
const sectionsEl = document.getElementById('sectionsContainer');

sectionsEl.addEventListener('click', (e) => {
  // Add Row (button in section header)
  if (e.target.classList.contains('addRowBtn')) {
    const payload = buildPayloadFromDOM();
    const secDiv = e.target.closest('.section');
    const index = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    payload.sections[index].rows.push({
      id: `new-${Date.now()}`,
      bus_number_default: '',
      pickup_default: '',
      dropoff_default: '',
      pickup_time_default: '00:00',
      note_default: '',
      ds_in_am_default: 0,
      ns_out_am_default: 0,
      ds_out_pm_default: 0,
      ns_in_pm_default: 0,
      position: payload.sections[index].rows.length
    });
    worksheetData = { ...worksheetData, sections: payload.sections };
    renderSections();
    return;
  }

  // Delete Section
  if (e.target.classList.contains('deleteSectionBtn')) {
    const secDiv = e.target.closest('.section');
    const index = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    const secName = secDiv.querySelector('.section-title')?.value?.trim() || `Section ${index+1}`;
    if (!confirm(`Delete section "${secName}" and all its rows? This cannot be undone.`)) return;

    const payload = buildPayloadFromDOM();
    payload.sections.splice(index, 1);
    payload.sections.forEach((s, i) => s.position = i);

    worksheetData = { ...worksheetData, sections: payload.sections };
    renderSections();
    return;
  }

  // Copy Section
  if (e.target.classList.contains('copySectionBtn')) {
    const secDiv = e.target.closest('.section');
    const index = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    const payload = buildPayloadFromDOM();

    const src = payload.sections[index];
    const copy = {
      ...src,
      id: `new-${Date.now()}`,
      section_name: (src.section_name || `Section ${index+1}`) + ' (Copy)',
      rows: (src.rows || []).map((r, i) => ({
        ...r,
        id: `new-${Date.now()}-${i}`,
        position: i
      }))
    };

    payload.sections.splice(index + 1, 0, copy);
    payload.sections.forEach((s, i) => s.position = i);

    worksheetData = { ...worksheetData, sections: payload.sections };
    renderSections();
    return;
  }

  // Delete Row
  if (e.target.classList.contains('deleteRowBtn')) {
    e.preventDefault();
    const payload = buildPayloadFromDOM();
    const secDiv = e.target.closest('.section');
    const secIndex = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    const tr = e.target.closest('tr');
    const rowIndex = Array.from(secDiv.querySelectorAll('tbody tr')).indexOf(tr);
    payload.sections[secIndex].rows.splice(rowIndex, 1);
    payload.sections[secIndex].rows.forEach((r, i) => r.position = i);
    worksheetData = { ...worksheetData, sections: payload.sections };
    renderSections();
    return;
  }

  // Copy Row
  if (e.target.classList.contains('copyRowBtn')) {
    e.preventDefault();
    const payload = buildPayloadFromDOM();
    const secDiv = e.target.closest('.section');
    const secIndex = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    const tr = e.target.closest('tr');
    const rowIndex = Array.from(secDiv.querySelectorAll('tbody tr')).indexOf(tr);

    const src = payload.sections[secIndex].rows[rowIndex];
    const copy = { ...src, id: `new-${Date.now()}`, position: rowIndex + 1 };
    payload.sections[secIndex].rows.splice(rowIndex + 1, 0, copy);

    payload.sections[secIndex].rows.forEach((r, i) => r.position = i);

    worksheetData = { ...worksheetData, sections: payload.sections };
    renderSections();
    return;
  }
});

// ---- Drag & Drop (handle-driven) ----
function clearRowDropIndicators() {
  document.querySelectorAll('tbody tr').forEach(tr => {
    tr.classList.remove('drop-before', 'drop-after');
  });
}

sectionsEl.addEventListener('dragstart', (e) => {
  // Row handle?
  const rowHandle = e.target.closest('.row-handle');
  if (rowHandle) {
    const tr = rowHandle.closest('tr');
    const secDiv = tr.closest('.section');
    dragRow.srcSecIdx = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    dragRow.srcRowIdx = Array.from(secDiv.querySelectorAll('tbody tr')).indexOf(tr);
    tr.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', 'row'); } catch {}
    return;
  }

  // Section handle?
  const secHandle = e.target.closest('.section-handle');
  if (secHandle) {
    const sec = secHandle.closest('.section');
    dragSec.srcSecIdx = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(sec);
    sec.classList.add('dragging-sec');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', 'section'); } catch {}
    return;
  }
});

sectionsEl.addEventListener('dragend', (e) => {
  document.querySelectorAll('tbody tr.dragging').forEach(tr => tr.classList.remove('dragging'));
  document.querySelectorAll('.section.dragging-sec').forEach(sec => sec.classList.remove('dragging-sec'));

  clearRowDropIndicators();
  document.querySelectorAll('.section').forEach(s => s.classList.remove('drop-before-sec','drop-after-sec'));

  dragRow.srcSecIdx = dragRow.srcRowIdx = null;
  dragRow.overTR = dragRow.overPos = null;

  dragSec.srcSecIdx = null;
  dragSec.overSecDiv = dragSec.overPos = null;
});

sectionsEl.addEventListener('dragover', (e) => {
  // Row reordering (within same section)
  const tr = e.target.closest('tbody tr');
  if (tr && dragRow.srcSecIdx != null) {
    const secDiv = tr.closest('.section');
    const overSecIdx = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    if (overSecIdx !== dragRow.srcSecIdx) return;

    e.preventDefault();
    const rect = tr.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const pos = y < rect.height / 2 ? 'before' : 'after';

    if (dragRow.overTR !== tr || dragRow.overPos !== pos) {
      clearRowDropIndicators();
      tr.classList.add(pos === 'before' ? 'drop-before' : 'drop-after');
      dragRow.overTR = tr;
      dragRow.overPos = pos;
    }
    return;
  }

  // Section reordering (entire cards)
  const secDiv = e.target.closest('.section');
  if (secDiv && dragSec.srcSecIdx != null) {
    e.preventDefault();
    const rect = secDiv.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const pos = y < rect.height / 2 ? 'before' : 'after';

    if (dragSec.overSecDiv !== secDiv || dragSec.overPos !== pos) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('drop-before-sec','drop-after-sec'));
      secDiv.classList.add(pos === 'before' ? 'drop-before-sec' : 'drop-after-sec');
      dragSec.overSecDiv = secDiv;
      dragSec.overPos = pos;
    }
  }
});

sectionsEl.addEventListener('drop', (e) => {
  // Row drop within same section
  const tr = e.target.closest('tbody tr');
  if (tr && dragRow.srcSecIdx != null) {
    const secDiv = tr.closest('.section');
    const overSecIdx = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    if (overSecIdx !== dragRow.srcSecIdx) return;

    e.preventDefault();

    const payload = buildPayloadFromDOM();
    const rows = payload.sections[overSecIdx].rows;

    const targetIdx = Array.from(secDiv.querySelectorAll('tbody tr')).indexOf(tr);
    let insertIdx = targetIdx;
    if (dragRow.overPos === 'after') insertIdx = targetIdx + 1;

    const [moved] = rows.splice(dragRow.srcRowIdx, 1);
    if (dragRow.srcRowIdx < targetIdx) insertIdx -= 1;
    rows.splice(insertIdx, 0, moved);

    rows.forEach((r, i) => r.position = i);

    worksheetData = { ...worksheetData, sections: payload.sections };
    renderSections();
    return;
  }

  // Section drop (reorder sections)
  const secDiv = e.target.closest('.section');
  if (secDiv && dragSec.srcSecIdx != null) {
    e.preventDefault();

    const container = document.getElementById('sectionsContainer');
    const targetIdx = Array.from(container.querySelectorAll('.section')).indexOf(secDiv);

    const payload = buildPayloadFromDOM();
    const sections = payload.sections;

    let insertIdx = dragSec.overPos === 'after' ? targetIdx + 1 : targetIdx;

    const [moved] = sections.splice(dragSec.srcSecIdx, 1);
    if (dragSec.srcSecIdx < targetIdx) insertIdx -= 1;

    sections.splice(insertIdx, 0, moved);
    sections.forEach((s, i) => s.position = i);

    worksheetData = { ...worksheetData, sections };
    renderSections();
  }
});

// Save All
document.getElementById('saveAllBtn').addEventListener('click', async () => {
  try {
    if (!currentWorksheetId) throw new Error('No worksheet selected');
    const payload = buildPayloadFromDOM();
    payload.id = currentWorksheetId;

    const res = await fetch('/api/worksheets', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await res.text());

    const serverWs = await res.json();
    worksheetData = serverWs;
    alert('Worksheet saved ✅');
    renderSections();
  } catch (err) {
    console.error(err);
    alert(`Save failed: ${err.message}`);
  }
});

// Set Default
document.getElementById('setDefaultBtn').addEventListener('click', async () => {
  if (!currentWorksheetId) return;
  const res = await fetch('/api/worksheets', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: currentWorksheetId, setDefault: true })
  });
  if (!res.ok) { alert(`Set default failed: ${await res.text()}`); return; }
  await loadWorksheets();
});

// Worksheet switch
document.getElementById('worksheetSelect').addEventListener('change', async (e) => {
  currentWorksheetId = e.target.value;
  await loadWorksheet(currentWorksheetId);
});

// Keyboard shortcuts inside modals
['newWorksheetName','newSectionName'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      if (id === 'newWorksheetName') document.getElementById('confirmNewWorksheet').click();
      if (id === 'newSectionName') document.getElementById('confirmNewSection').click();
    }
    if (e.key === 'Escape') {
      if (id === 'newWorksheetName') document.getElementById('cancelNewWorksheet').click();
      if (id === 'newSectionName') document.getElementById('cancelNewSection').click();
    }
  });
});

// Init
loadWorksheets();
