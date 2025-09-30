async function fetchBuses() {
  try {
    const res = await fetch('/api/buses');
    const rows = await res.json();
    renderGrid(rows);
  } catch (err) {
    console.error('Fetch buses failed:', err);
  }
}

function renderGrid(rows) {
  const tbody = document.querySelector('#grid tbody');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    tr.innerHTML = `
      <td contenteditable="false">${row.unit_number}</td>
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
    tr.children[0].setAttribute('contenteditable', 'true');
    btn.textContent = 'Save';
    btn.classList.replace('editBtn', 'saveEditBtn');
  } else if (btn.classList.contains('saveEditBtn')) {
    const unit = tr.children[0].textContent.trim();
    await fetch('/api/buses', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, unit_number: unit })
    });
    fetchBuses();
  } else if (btn.classList.contains('saveBtn')) {
    const unit = tr.children[0].textContent.trim();
    await fetch('/api/buses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unit_number: unit })
    });
    fetchBuses();
  }
});

document.addEventListener('DOMContentLoaded', fetchBuses);

// Search filter
document.getElementById('searchInput').addEventListener('input', () => {
  const q = document.getElementById('searchInput').value.toLowerCase();
  document.querySelectorAll('#grid tbody tr').forEach(tr => {
    const text = tr.innerText.toLowerCase();
    tr.style.display = text.includes(q) ? '' : 'none';
  });
});
