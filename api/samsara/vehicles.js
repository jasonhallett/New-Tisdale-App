import { samsaraGet } from '../../utils/samsara.js';
// /api/samsara/vehicles.js
// No Tags scope required: do NOT call /tags.
// Fetch /fleet/vehicles and filter by tag names if present; otherwise optional regex, else return all.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.SAMSARA_API_TOKEN;
  const base = (process.env.SAMSARA_API_BASE || 'https://api.samsara.com').replace(/\/$/, '');
  const tagName = process.env.SAMSARA_COACHES_TAGNAME || 'Coaches';
  const nameRegex = process.env.SAMSARA_COACHES_NAME_REGEX || '';

  if (!token) return res.status(500).json({ error: 'Missing SAMSARA_API_TOKEN' });

  try {
    const allVehicles = await listAllVehicles(base, token);
    const { filtered, reason } = filterVehicles(allVehicles, tagName, nameRegex);
    return res.status(200).json({ vehicles: filtered, filterInfo: { tagName, nameRegex, reason, total: allVehicles.length, returned: filtered.length } });
  } catch (e) {
    console.error('Vehicles endpoint failed:', e);
    const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
    return res.status(status).json({ error: 'Samsara error', status, details: e?.body || String(e?.message || e) });
  }
}

  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const err = new Error('Samsara error'); err.status = r.status; err.body = body; throw err;
  }
  return body;
}

async function listAllVehicles(base, token) {
  let after; const out = [];
  while (true) {
    const body = await samsaraGet(base, '/fleet/vehicles', token, { limit: 512, after });
    const arr = body?.data || body?.vehicles || [];
    out.push(...arr);
    const next = body?.pagination?.endCursor || body?.pagination?.nextPageToken || body?.pagination?.after;
    if (!next) break; after = next;
  }
  return out.map(v => ({
    id: v.id,
    name: v.name || v.externalId || v.vin || `Vehicle ${v.id}`,
    licensePlate: v.licensePlate || '',
    tags: v.tags || null,
    tagIds: v.tagIds || null
  }));
}

function filterVehicles(vehicles, tagName, nameRegex) {
  const lc = String(tagName).toLowerCase();
  const rx = nameRegex ? new RegExp(nameRegex) : null;

  const haveTagNames = vehicles.some(v => Array.isArray(v.tags) && v.tags.some(t => typeof t?.name === 'string'));
  if (haveTagNames) {
    const filtered = vehicles.filter(v => (v.tags || []).some(t => String(t?.name || '').toLowerCase() === lc));
    return { filtered, reason: 'filtered-by-tag-name' };
  }
  if (rx) {
    const filtered = vehicles.filter(v => rx.test(v.name || '') || rx.test(v.externalId || ''));
    return { filtered, reason: 'filtered-by-name-regex' };
  }
  return { filtered: vehicles, reason: 'no-tag-info-returned' };
}
