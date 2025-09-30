// /js/cote-daily-reports.js
async function fetchcote-daily-reports() {
  try {
    const res = await fetch('/api/cote-daily-reports?limit=50');
    if (!res.ok) throw new Error(`Failed to load Daily LEMs (${res.status})`);
    const data = await res.json();
    renderGrid(data);
  } catch (err) {
    console.error(err);
    document.querySelector('#grid tbody').innerHTML =
      `<tr><td colspan="7" style="text-align:center;color:red;">Error loading data</td></tr>`;
  }
}

function renderGrid(rows) {
  const tbody = document.querySelector('#grid tbody');
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.date}</td>
      <td>${row.buses_driver_only}</td>
      <td>${row.buses_driver_bus}</td>
      <td align="center"><button class="btn-small">View</button></td>
      <td align="center"><button class="btn-small">Edit</button></td>
      <td align="center"><button class="btn-small">Delete</button></td>
      <td align="center"><button class="btn-small">Email</button></td>
    `;
    tbody.appendChild(tr);
  }
}

document.addEventListener('DOMContentLoaded', fetchcote-daily-reports);
