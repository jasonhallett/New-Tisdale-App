// menu.js — client-side menu renderer (tries /api/menu; falls back to defaults)
async function fetchJSON(url) {
  try {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    return null;
  }
}

// Fallback menu if /api/menu is not present yet
const defaultMenu = [
  {
    id: 'new-inspection',
    label: 'New Inspection',
    href: 'new_inspection.html',
    sub: 'Start a motor coach under-vehicle inspection',
    icon: 'M3 12h18M3 6h18M3 18h18'
  },
  {
    id: 'output',
    label: 'Output / Print',
    href: 'output.html',
    sub: 'View or generate the one-page PDF',
    icon: 'M4 4h16v16H4z'
  },
  {
    id: 'logout',
    label: 'Logout',
    href: 'logout.html',
    sub: 'Sign out and return to the login page',
    icon: 'M10 17l5-5-5-5M3 12h12'
  }
];

function iconSvg(d) {
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`;
}

function renderMenu(items) {
  const grid = document.getElementById('menuGrid');
  grid.innerHTML = '';
  for (const item of items) {
    const a = document.createElement('a');
    a.className = 'card';
    a.href = item.href || '#';
    a.dataset.id = item.id;
    a.innerHTML = `
      <div class="icon">${iconSvg(item.icon || 'M12 2v20M2 12h20')}</div>
      <div style="display:flex; flex-direction:column;">
        <div class="label">${item.label}${item.badge ? `<span class="badge">${item.badge}</span>` : ''}</div>
        ${item.sub ? `<div class="sub">${item.sub}</div>` : ''}
      </div>
    `;
    // Disabled items
    if (item.disabled) {
      a.setAttribute('aria-disabled', 'true');
      a.style.opacity = '0.5';
      a.style.pointerEvents = 'none';
    }
    grid.appendChild(a);
  }
}

async function bootstrap() {
  // Show user name (if available)
  try {
    const me = await fetchJSON('/api/technicians/me');
    const userbox = document.getElementById('userbox');
    if (me && me.user) {
      const u = me.user;
      userbox.textContent = `${u.fullName || u.name || 'Technician'}${u.role ? ' · ' + u.role : ''}`;
    } else {
      userbox.textContent = 'Technician';
    }
  } catch { /* ignore */ }

  // Try server-driven menu first
  let items = await fetchJSON('/api/menu');
  if (!items || !Array.isArray(items) || items.length === 0) {
    items = defaultMenu;
  }
  renderMenu(items);

  // Build tag (cache-bust convenience)
  const tag = new Date().toISOString().replace('T',' ').slice(0,16);
  const el = document.getElementById('build-tag');
  if (el) el.textContent = tag;

  // Logout button (redundant to card)
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      } finally {
        window.location.href = '/logout.html';
      }
    });
  }
}

bootstrap();
