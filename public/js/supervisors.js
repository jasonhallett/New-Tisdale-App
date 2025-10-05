async function fetchSupervisors() {
  try {
    const res = await fetch('/api/supervisors');
    const rows = await res.json();
    renderGrid(rows);
  } catch (err) {
    console.error('Fetch supervisors failed:', err);
  }
}

function renderGrid(rows) {
  const tbody = document.querySelector('#grid tbody');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td contenteditable="false">${row.first_name}</td>
      <td contenteditable="false">${row.last_name}</td>
      <td><button class="btn-small editBtn">Edit</button></td>
    `;
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

document.querySelector('#grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = tr.dataset.id;

  if (btn.classList.contains('editBtn')) {
    tr.querySelectorAll('td[contenteditable]').forEach(td => td.setAttribute('contenteditable', 'true'));
    btn.textContent = 'Save';
    btn.classList.replace('editBtn', 'saveEditBtn');
  } else if (btn.classList.contains('saveEditBtn')) {
    const first = tr.children[0].textContent.trim();
    const last = tr.children[1].textContent.trim();
    await fetch('/api/supervisors', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, first_name: first, last_name: last })
    });
    fetchSupervisors();
  } else if (btn.classList.contains('saveBtn')) {
    const first = tr.children[0].textContent.trim();
    const last = tr.children[1].textContent.trim();
    await fetch('/api/supervisors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: first, last_name: last })
    });
    fetchSupervisors();
  }
});

document.addEventListener('DOMContentLoaded', fetchSupervisors);

// Search filter
document.getElementById('searchInput').addEventListener('input', () => {
  const q = document.getElementById('searchInput').value.toLowerCase();
  document.querySelectorAll('#grid tbody tr').forEach(tr => {
    const text = tr.innerText.toLowerCase();
    tr.style.display = text.includes(q) ? '' : 'none';
  });
});
