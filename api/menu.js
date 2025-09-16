// /api/menu.js — Optional server-driven menu (static for now)
export const config = { runtime: 'nodejs' };

// NOTE: You could decode JWT here and customize based on role.
// For now we send a static menu so the client can fetch and render it.
export default async function handler(req, res) {
  const items = [
    { id: 'new-inspection', label: 'New Inspection', href: '/new_inspection.html', sub: 'Start a motor coach under-vehicle inspection', icon: 'M3 12h18M3 6h18M3 18h18' },
    { id: 'output', label: 'Output / Print', href: '/output.html', sub: 'View or generate the one-page PDF', icon: 'M4 4h16v16H4z' },
    { id: 'logout', label: 'Logout', href: '/logout.html', sub: 'Sign out', icon: 'M10 17l5-5-5-5M3 12h12' }
  ];
  res.setHeader('Content-Type', 'application/json');
  res.status(200).end(JSON.stringify(items));
}
