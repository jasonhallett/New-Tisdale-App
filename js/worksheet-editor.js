let currentWorksheetId = null;
let worksheetData = { id: null, name: '', sections: [] };

async function loadWorksheets() {
  const res = await fetch('/api/worksheets');
  const worksheets = await res.json();
  const select = document.getElementById('worksheetSelect');
  select.innerHTML = worksheets.map(ws =>
    `<option value="${ws.id}" ${ws.is_default ? 'selected' : ''}>
       ${ws.name}${ws.is_default ? ' (Default)' : ''}
     </option>`
  ).join('');

  if (worksheets.length) {
    currentWorksheetId = worksheets.find(ws => ws.is_default)?.id || worksheets[0].id;
    select.value = currentWorksheetId;
    await loadWorksheet(currentWorksheetId);
  }
}

async function loadWorksheet(id) {
  const res = await fetch(`/api/worksheets?id=${id}`);
  worksheetData = await res.json();
  renderSections();
}

function renderSections() {
  const container = document.getElementById('sectionsContainer');
  container.innerHTML = '';
  worksheetData.sections.forEach((section, si) => {
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'section card';
    sectionDiv.dataset.id = section.id;
    sectionDiv.innerHTML = `
      <div class="section-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <input class="section-title" value="${section.section_name}" data-index="${si}" />
        <button class="btn-small addRowBtn" data-index="${si}">+ Add Row</button>
      </div>
      <table class="table compact">
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
          ${section.rows.map((r, ri) => `
            <tr data-id="${r.id}">
              <td contenteditable="true">${r.bus_number_default || ''}</td>
              <td contenteditable="true">${r.pickup_default || ''}</td>
              <td contenteditable="true">${r.dropoff_default || ''}</td>
              <td contenteditable="true">${r.pickup_time_default || ''}</td>
              <td contenteditable="true">${r.ds_in_am_default || 0}</td>
              <td contenteditable="true">${r.ns_out_am_default || 0}</td>
              <td contenteditable="true">${r.ds_out_pm_default || 0}</td>
              <td contenteditable="true">${r.ns_in_pm_default || 0}</td>
              <td>
                <a href="#" class="btn-link-sm deleteRowBtn" data-sindex="${si}" data-rindex="${ri}">Delete</a>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    container.appendChild(sectionDiv);
  });
}

document.getElementById('addSectionBtn').addEventListener('click', () => {
  worksheetData.sections.push({
    id: 'new-' + Date.now(),
    section_name: 'New Section',
    rows: []
  });
  renderSections();
});

document.getElementById('sectionsContainer').addEventListener('click', (e) => {
  if (e.target.classList.contains('addRowBtn')) {
    const sindex = e.target.dataset.index;
    worksheetData.sections[sindex].rows.push({
      id: 'new-' + Date.now(),
      bus_number_default: '',
      pickup_default: '',
      dropoff_default: '',
      pickup_time_default: '',
      ds_in_am_default: 0,
      ns_out_am_default: 0,
      ds_out_pm_default: 0,
      ns_in_pm_default: 0
    });
    renderSections();
  }

  if (e.target.classList.contains('deleteRowBtn')) {
    const sindex = e.target.dataset.sindex;
    const rindex = e.target.dataset.rindex;
    worksheetData.sections[sindex].rows.splice(rindex, 1);
    renderSections();
  }
});

document.getElementById('saveAllBtn').addEventListener('click', async () => {
  // sync DOM → data model
  document.querySelectorAll('.section').forEach((secDiv, si) => {
    const sec = worksheetData.sections[si];
    sec.section_name = secDiv.querySelector('.section-title').value;
    sec.position = si;

    const trs = secDiv.querySelectorAll('tbody tr');
    sec.rows = Array.from(trs).map((tr, ri) => {
      const tds = tr.querySelectorAll('td');
      return {
        id: sec.rows[ri]?.id || 'new-' + Date.now(),
        bus_number_default: tds[0].innerText.trim(),
        pickup_default: tds[1].innerText.trim(),
        dropoff_default: tds[2].innerText.trim(),
        pickup_time_default: tds[3].innerText.trim(),
        ds_in_am_default: parseInt(tds[4].innerText.trim()) || 0,
        ns_out_am_default: parseInt(tds[5].innerText.trim()) || 0,
        ds_out_pm_default: parseInt(tds[6].innerText.trim()) || 0,
        ns_in_pm_default: parseInt(tds[7].innerText.trim()) || 0,
        position: ri
      };
    });
  });

  await fetch('/api/worksheets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(worksheetData)
  });

  alert('Worksheet saved ✅');
  loadWorksheets();
});

document.getElementById('worksheetSelect').addEventListener('change', async (e) => {
  currentWorksheetId = e.target.value;
  await loadWorksheet(currentWorksheetId);
});

// Modal logic for creating new worksheet
const modal = document.getElementById('newWorksheetModal');
const modalInput = document.getElementById('newWorksheetName');
const modalCancel = document.getElementById('cancelNewWorksheet');
const modalConfirm = document.getElementById('confirmNewWorksheet');

document.getElementById('newWorksheetBtn').addEventListener('click', () => {
  modal.style.display = 'flex';
  modalInput.value = '';
  modalInput.focus();
});

modalCancel.addEventListener('click', () => {
  modal.style.display = 'none';
});

modalConfirm.addEventListener('click', async () => {
  const name = modalInput.value.trim();
  if (!name) return alert('Please enter a name');
  const res = await fetch('/api/worksheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const newWs = await res.json();
  modal.style.display = 'none';
  await loadWorksheets();
  document.getElementById('worksheetSelect').value = newWs.id;
  currentWorksheetId = newWs.id;
  await loadWorksheet(currentWorksheetId);
});

document.getElementById('setDefaultBtn').addEventListener('click', async () => {
  if (!currentWorksheetId) return;
  await fetch('/api/worksheets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: currentWorksheetId, setDefault: true })
  });
  await loadWorksheets();
});

loadWorksheets();
