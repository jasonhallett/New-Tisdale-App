// ===== State =====
let currentWorksheetId = null;
let worksheetData = { id: null, name: '', sections: [] };

// ===== Utilities =====
function assert(ok, msg) { if (!ok) throw new Error(msg); }

// Build a clean payload purely from the DOM (so we never lose edits)
function buildPayloadFromDOM() {
  const name = document.querySelector('#worksheetSelect option:checked')?.textContent?.replace(' (Default)', '') || worksheetData.name || 'Untitled';
  const sections = [];
  document.querySelectorAll('#sectionsContainer .section').forEach((secDiv, si) => {
    const section_name = secDiv.querySelector('.section-title').value.trim() || `Section ${si+1}`;
    const rows = [];
    secDiv.querySelectorAll('tbody tr').forEach((tr, ri) => {
      const tds = tr.querySelectorAll('td');
      rows.push({
        id: tr.dataset.id || `new-${Date.now()}-${ri}`,
        bus_number_default: tds[0].innerText.trim(),
        pickup_default:     tds[1].innerText.trim(),
        dropoff_default:    tds[2].innerText.trim(),
        pickup_time_default:tds[3].innerText.trim(),
        ds_in_am_default:   parseInt(tds[4].innerText.trim() || '0', 10),
        ns_out_am_default:  parseInt(tds[5].innerText.trim() || '0', 10),
        ds_out_pm_default:  parseInt(tds[6].innerText.trim() || '0', 10),
        ns_in_pm_default:   parseInt(tds[7].innerText.trim() || '0', 10),
        position: ri
      });
    });
    sections.push({ id: secDiv.dataset.id || `new-${Date.now()}-${si}`, section_name, position: si, rows });
  });
  return { id: currentWorksheetId, name, sections };
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

  // Populate dropdown
  select.innerHTML = worksheets.map(ws =>
    `<option value="${ws.id}" ${ws.is_default ? 'selected' : ''}>
       ${ws.name}${ws.is_default ? ' (Default)' : ''}
     </option>`).join('');

  if (!worksheets.length) {
    // No worksheets yet → open New Worksheet modal automatically
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

  worksheetData.sections.forEach((section, si) => {
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'section card mb-4';
    sectionDiv.dataset.id = section.id || '';
    sectionDiv.innerHTML = `
      <div class="section-header flex justify-between items-center mb-2">
        <input class="section-title border border-gray-300 rounded-md p-1" value="${section.section_name || ''}" />
        <button class="btn-small addRowBtn">+ Add Row</button>
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
              <td contenteditable="true">${r.bus_number_default || ''}</td>
              <td contenteditable="true">${r.pickup_default || ''}</td>
              <td contenteditable="true">${r.dropoff_default || ''}</td>
              <td contenteditable="true">${r.pickup_time_default || ''}</td>
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

// ===== Modals (exact behavior as your existing modals) =====
function openModal(id, focusId) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  if (focusId) {
    const input = document.getElementById(focusId);
    setTimeout(() => input?.focus(), 50);
  }
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Backdrop click closes
['newWorksheetModal', 'newSectionModal'].forEach(modalId => {
  const modal = document.getElementById(modalId);
  modal?.addEventListener('click', (e) => {
    // Only close if the click is on the backdrop (the absolute overlay or the outer container), not the card
    if (e.target.id === modalId || e.target.id === `${modalId.replace('Modal','')}Backdrop`) {
      closeModal(modalId);
    }
  });
});

// ===== Event wiring =====
document.getElementById('newWorksheetBtn').addEventListener('click', () => {
  openModal('newWorksheetModal', 'newWorksheetName');
});

document.getElementById('cancelNewWorksheet').addEventListener('click', () => {
  closeModal('newWorksheetModal');
});

document.getElementById('confirmNewWorksheet').addEventListener('click', async () => {
  const name = document.getElementById('newWorksheetName').value.trim();
  if (!name) return alert('Enter a name');
  const res = await fetch('/api/worksheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  if (!res.ok) {
    const t = await res.text();
    alert(`Create failed: ${t}`);
    return;
  }
  const newWs = await res.json();
  closeModal('newWorksheetModal');
  await loadWorksheets();
  document.getElementById('worksheetSelect').value = newWs.id;
  currentWorksheetId = newWs.id;
  await loadWorksheet(currentWorksheetId);
});

// New Section modal
document.getElementById('addSectionBtn').addEventListener('click', () => {
  openModal('newSectionModal', 'newSectionName');
});

document.getElementById('cancelNewSection').addEventListener('click', () => {
  closeModal('newSectionModal');
});

document.getElementById('confirmNewSection').addEventListener('click', () => {
  const name = document.getElementById('newSectionName').value.trim();
  if (!name) return alert('Enter a section name');
  // Build from DOM to avoid wiping names
  const payload = buildPayloadFromDOM();
  payload.sections.push({ id: `new-${Date.now()}`, section_name: name, position: payload.sections.length, rows: [] });
  // Replace in-memory and re-render
  worksheetData = { ...worksheetData, sections: payload.sections };
  closeModal('newSectionModal');
  renderSections();
});

// Row add/delete using event delegation
document.getElementById('sectionsContainer').addEventListener('click', (e) => {
  if (e.target.classList.contains('addRowBtn')) {
    const payload = buildPayloadFromDOM();
    // Find section index by DOM order
    const secDiv = e.target.closest('.section');
    const index = Array.from(document.querySelectorAll('#sectionsContainer .section')).indexOf(secDiv);
    payload.sections[index].rows.push({
      id: `new-${Date.now()}`,
      bus_number_default: '',
      pickup_default: '',
      dropoff_default: '',
      pickup_time_default: '',
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
  }
});

// Save All → always build from DOM to guarantee we send what you see
document.getElementById('saveAllBtn').addEventListener('click', async () => {
  try {
    assert(currentWorksheetId, 'No worksheet selected');
    const payload = buildPayloadFromDOM();
    payload.id = currentWorksheetId; // ensure we send the id we’re editing

    const res = await fetch('/api/worksheets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(t);
    }

    alert('Worksheet saved ✅');
    await loadWorksheet(currentWorksheetId);
  } catch (err) {
    console.error(err);
    alert(`Save failed: ${err.message}`);
  }
});

document.getElementById('setDefaultBtn').addEventListener('click', async () => {
  if (!currentWorksheetId) return;
  const res = await fetch('/api/worksheets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: currentWorksheetId, setDefault: true })
  });
  if (!res.ok) {
    const t = await res.text();
    alert(`Set default failed: ${t}`);
    return;
  }
  await loadWorksheets();
});

document.getElementById('worksheetSelect').addEventListener('change', async (e) => {
  currentWorksheetId = e.target.value;
  await loadWorksheet(currentWorksheetId);
});

// Keyboard: Enter confirms, Escape cancels in active modal
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
