// ===== State =====
let currentWorksheetId = null;
let worksheetData = { id: null, name: '', sections: [] };

// ===== Modal helpers (now using global CSS: .modal + .open) =====
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
// Backdrop click closes
['newWorksheetModal','newSectionModal'].forEach(mid => {
  const modal = document.getElementById(mid);
  modal?.addEventListener('click', (e) => {
    if (e.target.dataset.close === 'true' || e.target.classList.contains('backdrop')) closeModal(mid);
  });
});

// ===== Utilities =====
function assert(ok, msg) { if (!ok) throw new Error(msg); }

// Build payload purely from DOM
function buildPayloadFromDOM() {
  const select = document.getElementById('worksheetSelect');
  const selectedOption = select?.options?.[select.selectedIndex];
  const nameFromSelect = selectedOption ? selectedOption.textContent.replace(' (Default)','') : (worksheetData.name || 'Untitled');

  const sections = [];
  document.querySelectorAll('#sectionsContainer .section').forEach((secDiv, si) => {
    const section_name = secDiv.querySelector('.section-title')?.value?.trim() || `Section ${si+1}`;
    const rows = [];
    secDiv.querySelectorAll('tbody tr').forEach((tr, ri) => {
      const tds = tr.querySelectorAll('td');
      rows.push({
        id: tr.dataset.id || `new-${Date.now()}-${ri}`,
        bus_number_default: tds[0]?.innerText.trim() || '',
        pickup_default:     tds[1]?.innerText.trim() || '',
        dropoff_default:    tds[2]?.innerText.trim() || '',
        pickup_time_default:tds[3]?.innerText.trim() || '',
        ds_in_am_default:   parseInt(tds[4]?.innerText.trim() || '0', 10),
        ns_out_am_default:  parseInt(tds[5]?.innerText.trim() || '0', 10),
        ds_out_pm_default:  parseInt(tds[6]?.innerText.trim() || '0', 10),
        ns_in_pm_default:   parseInt(tds[7]?.innerText.trim() || '0', 10),
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
function renderSections() {
  const container = document.getElementById('sectionsContainer');
  container.innerHTML = '';

  if (!worksheetData || !Array.isArray(worksheetData.sections)) {
    worksheetData = { id: currentWorksheetId, name: worksheetData?.name || '', sections: [] };
  }

  worksheetData.sections.forEach((section) => {
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'section card';
    sectionDiv.style.marginBottom = '16px';
    sectionDiv.dataset.id = section.id || '';
    sectionDiv.innerHTML = `
      <div class="section-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <input class="section-title" value="${section.section_name || ''}" style="border:1px solid var(--line);border-radius:8px;padding:6px 8px;"/>
        <button class="btn btn-ghost addRowBtn">+ Add Row</button>
      </div>
      <table class="table compact w-full">
        <thead>
          <tr>
            <th>Bus Number(s)</th>
            <th>Pickup</th>
            <th>Dropoff</th>
            <th>Pickup Time AM/PM</th>
            <th>D/S IN AM</th>
            <th>N/S OUT AM</th>
            <th>D/S OUT PM</th>
            <th>N/S IN PM</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${(section.rows || []).map((r) => `
            <tr data-id="${r.id || ''}">
              <td contenteditable="true">${r.bus_number_default ?? ''}</td>
              <td contenteditable="true">${r.pickup_default ?? ''}</td>
              <td contenteditable="true">${r.dropoff_default ?? ''}</td>
              <td contenteditable="true">${r.pickup_time_default ?? ''}</td>
              <td contenteditable="true">${r.ds_in_am_default ?? 0}</td>
              <td contenteditable="true">${r.ns_out_am_default ?? 0}</td>
              <td contenteditable="true">${r.ds_out_pm_default ?? 0}</td>
              <td contenteditable="true">${r.ns_in_pm_default ?? 0}</td>
              <td><a href="#" class="btn-link-sm deleteRowBtn">Delete</a></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    container.appendChild(sectionDiv);
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

// Row add/delete
document.getElementById('sectionsContainer').addEventListener('click', (e) => {
  if (e.target.classList.contains('addRowBtn')) {
    const payload = buildPayloadFromDOM();
    const secDiv = e.target.closest('.section');
    const index = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    payload.sections[index].rows.push({
      id: `new-${Date.now()}`, bus_number_default: '', pickup_default: '', dropoff_default: '',
      pickup_time_default: '', ds_in_am_default: 0, ns_out_am_default: 0, ds_out_pm_default: 0, ns_in_pm_default: 0,
      position: payload.sections[index].rows.length
    });
    worksheetData = { ...worksheetData, sections: payload.sections };
    renderSections();
    return;
  }

  if (e.target.classList.contains('deleteRowBtn')) {
    e.preventDefault();
    const payload = buildPayloadFromDOM();
    const secDiv = e.target.closest('section, .section');
    const secIndex = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    const tr = e.target.closest('tr');
    const rowIndex = Array.from(secDiv.querySelectorAll('tbody tr')).indexOf(tr);
    payload.sections[secIndex].rows.splice(rowIndex, 1);
    payload.sections[secIndex].rows.forEach((r, i) => r.position = i);
    worksheetData = { ...worksheetData, sections: payload.sections };
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
