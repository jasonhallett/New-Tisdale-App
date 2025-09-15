// /api/samsara/vehicle-stats.js
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.SAMSARA_API_TOKEN;
  const base = (process.env.SAMSARA_API_BASE || 'https://api.samsara.com').replace(/\/$/, '');
  if (!token) return res.status(500).json({ error: 'Missing SAMSARA_API_TOKEN' });

  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing required query param: id' });

  try {
    const body = await samsaraGet(base, '/fleet/vehicles/stats', token, { types: 'obdOdometerMeters,gpsOdometerMeters', vehicleIds: String(id) });
    const data = body?.data || body?.vehicles || [];
    const entry = Array.isArray(data) ? (data.find(v => String(v.id) === String(id)) || data[0]) : data;
    const obd = entry?.obdOdometerMeters?.value ?? entry?.stats?.obdOdometerMeters?.value;
    const gps = entry?.gpsOdometerMeters?.value ?? entry?.stats?.gpsOdometerMeters?.value;
    const odometerMeters = Number.isFinite(obd) ? obd : (Number.isFinite(gps) ? gps : null);
    return res.status(200).json({ vehicleId: id, odometerMeters });
  } catch (e) {
    if (e?.status === 400) {
      try {
        const body2 = await samsaraGet(base, '/fleet/vehicles/stats', token, { types: 'obdOdometerMeters,gpsOdometerMeters', ids: String(id) });
        const data2 = body2?.data || body2?.vehicles || [];
        const entry2 = Array.isArray(data2) ? (data2.find(v => String(v.id) === String(id)) || data2[0]) : data2;
        const obd2 = entry2?.obdOdometerMeters?.value ?? entry2?.stats?.obdOdometerMeters?.value;
        const gps2 = entry2?.gpsOdometerMeters?.value ?? entry2?.stats?.gpsOdometerMeters?.value;
        const odometerMeters2 = Number.isFinite(obd2) ? obd2 : (Number.isFinite(gps2) ? gps2 : null);
        return res.status(200).json({ vehicleId: id, odometerMeters: odometerMeters2 });
      } catch (e2) {
        const status2 = e2?.status && Number.isInteger(e2.status) ? e2.status : 500;
        return res.status(status2).json({ error: 'Samsara error', status: status2, details: e2?.body || String(e2?.message || e2) });
      }
    }
    const status = e?.status && Number.isInteger(e.status) ? e.status : 500;
    return res.status(status).json({ error: 'Samsara error', status, details: e?.body || String(e?.message || e) });
  }
}

async function samsaraGet(base, path, token, query = {}) {
  const cleaned = {};
  Object.entries(query).forEach(([k, v]) => {
    if (v === undefined || v === null) return;
    if (typeof v === 'string' && v.trim() === '') return;
    cleaned[k] = v;
  });
  const qs = new URLSearchParams(cleaned).toString();
  const url = base + path + (qs ? ('?' + qs) : '');
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Samsara-Version': '2024-05-01'
    }
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) { const err = new Error('Samsara error'); err.status = r.status; err.body = body; throw err; }
  return body;
}