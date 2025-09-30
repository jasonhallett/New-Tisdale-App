async function fetchDrivers() {
  try {
    const res = await fetch('/api/drivers');
    const rows = await res.json();
    renderGrid(rows);
  } catch (err) {
    console.error('Fetch drivers failed:', err);
    document.querySelector('#grid tbody').innerHTML =
      `<tr><td colspan="3">Unable to load drivers.</td></tr>`;
  }
}

function htmlesc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

function renderGrid(rows) {
  const tbody = document.querySelector('#grid tbody');
  tbody.innerHTML = rows.map(row => {
    return `<tr data-id="${htmlesc(row.id)}">
      <td>${htmlesc(row.first_name)}</td>
      <td>${htmlesc(row.last_name)}</td>
      <td class="col-view">
        <a href="#" class="btn-link-sm editBtn">Edit</a>
      </td>
    </tr>`;
  }).join('');
}

document.getElementById('addBtn').addEventListener('click', () => {
  const tbody = document.querySelector('#grid tbody');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td contenteditable="true"></td>
    <td contenteditable="true"></td>
    <td class="col-view">
      <a href="#" class="btn-link-sm saveBtn">Save</a>
      <a href="#" class="btn-link-sm cancelBtn">Cancel</a>
    </td>
  `;
  tbody.prepend(tr);
});

document.querySelector('#grid').addEventListener('click', async (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const tr = a.closest('tr');
  const id = tr.dataset.id;

  if (a.classList.contains('editBtn')) {
    // Make row editable
    tr.children[0].setAttribute('contenteditable', 'true');
    tr.children[1].setAttribute('contenteditable', 'true');
    tr.querySelector('.col-view').innerHTML = `
      <a href="#" class="btn-link-sm saveEditBtn">Save</a>
      <a href="#" class="btn-link-sm cancelBtn">Cancel</a>
    `;
  }
  else if (a.classList.contains('saveEditBtn')) {
    const first = tr.children[0].textContent.trim();
    const last = tr.children[1].textContent.trim();
    await fetch('/api/drivers', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, first_name: first, last_name: last })
    });
    fetchDrivers();
  }
  else if (a.classList.contains('saveBtn')) {
    const first = tr.children[0].textContent.trim();
    const last = tr.children[1].textContent.trim();
    await fetch('/api/drivers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ first_name: first, last_name: last })
    });
    fetchDrivers();
  }
  else if (a.classList.contains('cancelBtn')) {
    fetchDrivers(); // reload, discard changes
  }
});

document.addEventListener('DOMContentLoaded', fetchDrivers);
