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

function syncSectionNames() {
  document.querySelectorAll('.section').forEach((secDiv, si) => {
    const titleInput = secDiv.querySelector('.section-title');
    if (titleInput) worksheetData.sections[si].section_name = titleInput.value;
  });
}

function renderSections() {
  const container = document.getElementById('sectionsContainer');
  container.innerHTML = '';
  worksheetData.sections.forEach((section, si) => {
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'section card mb-4';
    sectionDiv.dataset.id = section.id;
    sectionDiv.innerHTML = `
      <div class="section-header flex justify-between items-center mb-2">
        <input class="section-title border border-gray-300 rounded-md p-1" value="${section.section_name}" data-index="${si}" />
        <button class="btn-small addRowBtn" data-index="${si}">+ Add Row</button>
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
  // open modal
  document.getElementById('newSectionModal').classList.remove('hidden');
  document.getElementById('newSectionName').value = '';
  setTimeout(() => document.getElementById('newSectionName').focus(), 50);
});

document.getElementById('sectionsContainer').addEventListener('click', (e) => {
  if (e.target.classList.contains('addRowBtn')) {
    syncSectionNames();
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
    syncSectionNames();
    const sindex = e.target.dataset.sindex;
    const rindex = e.target.dataset.rindex;
    worksheetData.sections[sindex].rows.splice(rindex, 1);
    renderSections();
  }
});

document.getElementById('saveAllBtn').addEventListener('click', async () => {
  // sync DOM → data model
  syncSectionNames();
  document.querySelectorAll('.section').forEach((secDiv, si) => {
    const sec = worksheetData.sections[si];
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

// Worksheet Modal
const worksheetModal = document.getElementById('newWorksheetModal');
const worksheetInput = document.getElementById('newWorksheetName');
document.getElementById('newWorksheetBtn').addEventListener('click', () => {
  worksheetModal.classList.remove('hidden');
  worksheetInput.value = '';
  setTimeout(() => worksheetInput.focus(), 50);
});
document.getElementById('cancelNewWorksheet').addEventListener('click', () => {
  worksheetModal.classList.add('hidden');
});
document.getElementById('confirmNewWorksheet').addEventListener('click', async () => {
  const name = worksheetInput.value.trim();
  if (!name) return alert('Please enter a name');
  const res = await fetch('/api/worksheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const newWs = await res.json();
  worksheetModal.classList.add('hidden');
  await loadWorksheets();
  document.getElementById('worksheetSelect').value = newWs.id;
  currentWorksheetId = newWs.id;
  await loadWorksheet(currentWorksheetId);
});

// Section Modal
const sectionModal = document.getElementById('newSectionModal');
const sectionInput = document.getElementById('newSectionName');
document.getElementById('cancelNewSection').addEventListener('click', () => {
  sectionModal.classList.add('hidden');
});
document.getElementById('confirmNewSection').addEventListener('click', () => {
  const name = sectionInput.value.trim();
  if (!name) return alert('Please enter a name');
  worksheetData.sections.push({
    id: 'new-' + Date.now(),
    section_name: name,
    rows: []
  });
  sectionModal.classList.add('hidden');
  renderSections();
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
