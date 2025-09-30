async function fetchDrivers() {
  const res = await fetch('/api/drivers');
  const rows = await res.json();
  renderGrid(rows);
}

function renderGrid(rows) {
  const tbody = document.querySelector('#grid tbody');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td contenteditable="false">${row.first_name}</td>
      <td contenteditable="false">${row.last_name}</td>
      <td>
        <button class="btn-small editBtn">Edit</button>
      </td>
    `;
    tr.dataset.id = row.id;
    tbody.appendChild(tr);
  }
}

document.getElementById('addBtn').addEventListener('click', () => {
  const tbody = document.querySelector('#grid tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td contenteditable="true"></td>
    <td contenteditable="true"></td>
    <td><button class="btn-small saveBtn">Save</button></td>
  `;
  tbody.appendChild(tr);
});

// Delegated handler for Edit/Save
document.querySelector('#grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr.dataset.id;

  if (btn.classList.contains('editBtn')) {
    tr.querySelectorAll('td[contenteditable]').forEach(td => td.setAttribute('contenteditable', 'true'));
    btn.textContent = 'Save';
    btn.classList.remove('editBtn');
    btn.classList.add('saveEditBtn');
  }
  else if (btn.classList.contains('saveEditBtn')) {
    const first = tr.children[0].textContent.trim();
    const last = tr.children[1].textContent.trim();
    await fetch('/api/drivers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, first_name: first, last_name: last })
    });
    fetchDrivers();
  }
  else if (btn.classList.contains('saveBtn')) {
    const first = tr.children[0].textContent.trim();
    const last = tr.children[1].textContent.trim();
    await fetch('/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: first, last_name: last })
    });
    fetchDrivers();
  }
});

document.addEventListener('DOMContentLoaded', fetchDrivers);
