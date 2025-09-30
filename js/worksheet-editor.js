let currentWorksheetId = null;
let worksheetData = { sections: [] };

async function loadWorksheets() {
  const res = await fetch('/api/worksheets');
  const worksheets = await res.json();
  const select = document.getElementById('worksheetSelect');
  select.innerHTML = worksheets.map(ws =>
    `<option value="${ws.id}">${ws.name}</option>`
  ).join('');
  if (worksheets.length) {
    currentWorksheetId = worksheets[0].id;
    select.value = currentWorksheetId;
    loadWorksheet(currentWorksheetId);
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
  worksheetData.sections.forEach(section => {
    const sectionDiv = document.createElement('div');
    sectionDiv.className = 'section card';
    sectionDiv.dataset.id = section.id;
    sectionDiv.innerHTML = `
      <div class="section-header">
        <input class="section-title" value="${section.title}" />
        <button class="btn-small addFieldBtn">+ Add Field</button>
      </div>
      <div class="fields" data-section="${section.id}">
        ${section.fields.map(f => `
          <div class="field" data-id="${f.id}">
            <input class="field-label" value="${f.label}" />
            <button class="btn-small deleteFieldBtn">×</button>
          </div>
        `).join('')}
      </div>
    `;
    container.appendChild(sectionDiv);

    // Make fields sortable
    new Sortable(sectionDiv.querySelector('.fields'), {
      animation: 150,
      onEnd: savePositions
    });
  });

  // Make sections sortable
  new Sortable(container, {
    animation: 150,
    handle: '.section-header',
    onEnd: savePositions
  });
}

function savePositions() {
  // Collect positions from DOM
  worksheetData.sections = Array.from(document.querySelectorAll('.section')).map((sec, i) => ({
    id: sec.dataset.id,
    title: sec.querySelector('.section-title').value,
    position: i,
    fields: Array.from(sec.querySelectorAll('.field')).map((f, j) => ({
      id: f.dataset.id,
      label: f.querySelector('.field-label').value,
      position: j
    }))
  }));
}

document.getElementById('addSectionBtn').addEventListener('click', () => {
  worksheetData.sections.push({ id: 'new-' + Date.now(), title: 'New Section', fields: [] });
  renderSections();
});

document.getElementById('sectionsContainer').addEventListener('click', e => {
  if (e.target.classList.contains('addFieldBtn')) {
    const sectionDiv = e.target.closest('.section');
    const sectionId = sectionDiv.dataset.id;
    const section = worksheetData.sections.find(s => s.id == sectionId);
    section.fields.push({ id: 'new-' + Date.now(), label: 'New Field' });
    renderSections();
  }
  if (e.target.classList.contains('deleteFieldBtn')) {
    const fieldDiv = e.target.closest('.field');
    const sectionDiv = e.target.closest('.section');
    const sectionId = sectionDiv.dataset.id;
    const section = worksheetData.sections.find(s => s.id == sectionId);
    section.fields = section.fields.filter(f => f.id != fieldDiv.dataset.id);
    renderSections();
  }
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  savePositions();
  await fetch('/api/worksheets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: currentWorksheetId, sections: worksheetData.sections })
  });
  alert('Worksheet saved ✅');
});

document.getElementById('worksheetSelect').addEventListener('change', e => {
  currentWorksheetId = e.target.value;
  loadWorksheet(currentWorksheetId);
});

document.getElementById('newWorksheetBtn').addEventListener('click', async () => {
  const name = prompt('Enter new worksheet name:');
  if (!name) return;
  const res = await fetch('/api/worksheets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  const newWs = await res.json();
  await loadWorksheets();
  document.getElementById('worksheetSelect').value = newWs.id;
  currentWorksheetId = newWs.id;
  loadWorksheet(currentWorksheetId);
});

loadWorksheets();
