// utils/samsara.js — shared GET wrapper for Samsara API
export async function samsaraGet(base, path, token, query = {}) {
  const cleaned = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    cleaned[k] = v;
  }
  const qs = new URLSearchParams(cleaned).toString();
  const url = base.replace(/\/$/, '') + path + (qs ? ('?' + qs) : '');

  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Samsara-Version': '2024-05-01'
    }
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const err = new Error('Samsara error');
    err.status = r.status; err.body = body;
    throw err;
  }
  return body;
}
