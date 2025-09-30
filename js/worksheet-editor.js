// /js/worksheet-editor.js
let currentTemplate = null;

async function fetchTemplates() {
  const res = await fetch('/api/worksheet-templates');
  const templates = await res.json();
  renderTemplates(templates);
}

function renderTemplates(templates) {
  const list = document.getElementById('templatesList');
  list.innerHTML = templates.map(t => `
    <div class="card" style="padding:8px;margin-bottom:8px;cursor:pointer;" data-id="${t.id}">
      <strong>${t.name}</strong> (v${t.version})
    </div>
  `).join('');

  list.querySelectorAll('[data-id]').forEach(el => {
    el.addEventListener('click', () => loadTemplate(el.dataset.id));
  });
}

async function loadTemplate(id) {
  const res = await fetch(`/api/worksheet-templates?id=${id}`);
  currentTemplate = await res.json();
  document.getElementById('editor').style.display = 'block';
  document.getElementById('templateName').textContent = `${currentTemplate.name} (v${currentTemplate.version})`;
  renderSections();
}

function renderSections() {
  const container = document.getElementById('sections');
  container.innerHTML = '';
  currentTemplate.sections.forEach(section => {
    const div = document.createElement('div');
    div.className = 'card';
    div.style.margin = '12px 0';
    div.innerHTML = `
      <h4>${section.title}</h4>
      <button class="btn-small addColBtn" data-id="${section.id}">+ Add Column</button>
      <table class="table compact">
        <thead>
          <tr><th>Label</th><th>Key</th><th>Type</th></tr>
        </thead>
        <tbody>
          ${section.columns.map(col => `
            <tr>
              <td>${col.label}</td>
              <td>${col.key}</td>
              <td>${col.data_type}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    container.appendChild(div);
  });
}

document.getElementById('newTemplateBtn').addEventListener('click', async () => {
  const name = prompt('Template name?');
  if (!name) return;
  const res = await fetch('/api/worksheet-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name })
  });
  await fetchTemplates();
});

document.getElementById('addSectionBtn').addEventListener('click', async () => {
  const title = prompt('Section title?');
  if (!title || !currentTemplate) return;
  currentTemplate.sections.push({ title, columns: [] });
  renderSections();
});

document.getElementById('saveTemplateBtn').addEventListener('click', async () => {
  if (!currentTemplate) return;
  await fetch('/api/worksheet-templates', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentTemplate)
  });
  alert('Template saved');
  await fetchTemplates();
});

fetchTemplates();
