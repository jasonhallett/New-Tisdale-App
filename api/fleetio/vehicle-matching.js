// /api/fleetio/vehicle-matching.js
// Centralized vehicle <-> unit matching utilities for Fleetio.

const BASE_V1 = 'https://secure.fleetio.com/api/v1';
const BASE_V2 = 'https://secure.fleetio.com/api/v2';

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const API_TOKEN = requiredEnv('FLEETIO_API_TOKEN');
const ACCOUNT_TOKEN = requiredEnv('FLEETIO_ACCOUNT_TOKEN');

const defaultHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Authorization: `Token ${API_TOKEN}`,
  'Account-Token': ACCOUNT_TOKEN
};

async function fleetioV1(path, init = {}, step = 'fleetioV1') {
  const res = await fetch(`${BASE_V1}${path}`, { ...init, headers: { ...(init.headers||{}), ...defaultHeaders } });
  if (!res.ok) {
    const body = await res.text().catch(()=>''); const err = new Error(`[${step}] v1 ${init.method||'GET'} ${path} failed: ${res.status} ${body}`);
    err.status = res.status; err.details = body; throw err;
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}
async function fleetioV2(path, init = {}, step = 'fleetioV2') {
  const res = await fetch(`${BASE_V2}${path}`, { ...init, headers: { ...(init.headers||{}), ...defaultHeaders } });
  if (!res.ok) {
    const body = await res.text().catch(()=>''); const err = new Error(`[${step}] v2 ${init.method||'GET'} ${path} failed: ${res.status} ${body}`);
    err.status = res.status; err.details = body; throw err;
  }
  return res.headers.get('content-type')?.includes('json') ? res.json() : res.text();
}

export function normalize(s) { return String(s || '').trim().toLowerCase(); }
export function sanitizeUnitStr(s){ return String(s||'').toLowerCase().replace(/[^a-z0-9]/g,''); }
function notEmpty(x){ return x != null && String(x).trim() !== ''; }

export function candidateStringsFromVehicle(v) {
  const out = new Set();
  [
    v?.vehicle_number, v?.name, v?.external_id, v?.label,
    v?.identifier, v?.unit, v?.unit_number, v?.number
  ].forEach(s => { if (notEmpty(s)) { out.add(String(s)); out.add(sanitizeUnitStr(String(s))); } });

  const cf = v?.custom_fields || v?.customFields || null;
  if (cf && typeof cf === 'object') {
    Object.entries(cf).forEach(([k, val]) => {
      if (!notEmpty(val)) return;
      const key = String(k).toLowerCase();
      if (key.includes('unit') || key.includes('fleet') || key.includes('number') || key.includes('bus') || key.includes('coach')) {
        out.add(String(val));
        out.add(sanitizeUnitStr(String(val)));
      }
    });
  }
  return Array.from(out);
}

export function vehicleLabel(v) {
  return v?.vehicle_number || v?.name || v?.external_id || v?.label || `Vehicle ${v?.id}`;
}

function scoreMatch(unitNumber, v) {
  const n = normalize(unitNumber);
  const s = sanitizeUnitStr(unitNumber);
  if (!n && !s) return { score: 0, reason: 'empty-input' };

  const cands = candidateStringsFromVehicle(v).map(String);
  let best = 0; let why = 'none';

  for (const cand of cands) {
    const cn = normalize(cand);
    const cs = sanitizeUnitStr(cand);

    if (cn === n || cs === s) { best = Math.max(best, 100); why = 'exact'; if (best===100) break; }
    else if (cn.includes(n) || cs.includes(s)) { best = Math.max(best, 60); why = 'contains'; }
    else if (cn.endsWith(n) || cn.startsWith(n) || cs.endsWith(s) || cs.startsWith(s)) { best = Math.max(best, 70); why = 'prefix/suffix'; }
  }

  return { score: best, reason: why };
}

export async function listAllVehicles() {
  const all = [];
  const PER_PAGE = 100;
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const params = new URLSearchParams({ per_page: String(PER_PAGE) });
    if (cursor) params.set('start_cursor', cursor);
    const out = await fleetioV1(`/vehicles?${params.toString()}`, {}, 'list_vehicles');
    const records = Array.isArray(out) ? out : (out?.records || out?.data || []);
    const next = out?.next_cursor || null;
    if (records?.length) all.push(...records);
    if (!next) break;
    cursor = next;
  }
  if (all.length === 0) {
    let page = 1;
    for (let p = 0; p < 25; p++) {
      const qs = new URLSearchParams({ page: String(page), per_page: String(PER_PAGE) });
      const out = await fleetioV1(`/vehicles?${qs.toString()}`, {}, 'list_vehicles_fallback');
      const items = Array.isArray(out) ? out : (out?.data || out?.records || []);
      if (!items?.length) break;
      all.push(...items);
      if (items.length < PER_PAGE) break;
      page++;
    }
  }
  return all;
}

export function buildIndex(vehicles) {
  const map = new Map();
  for (const v of vehicles) {
    const cands = candidateStringsFromVehicle(v);
    for (const c of cands) {
      map.set(normalize(c), v);
      map.set(sanitizeUnitStr(c), v);
    }
  }
  return map;
}

export async function getVehicleIdForUnit(unitNumber, options = {}) {
  const minScore = options.minScore ?? 80;
  const unitNorm = normalize(unitNumber);
  const unitSan  = sanitizeUnitStr(unitNumber);
  if (!unitNorm && !unitSan) return { id: null, vehicle: null, match: { score: 0, reason: 'empty-input' } };

  const vehicles = options.vehicles || await listAllVehicles();
  let best = { vehicle: null, score: 0, reason: 'none' };
  for (const v of vehicles) {
    const { score, reason } = scoreMatch(unitNumber, v);
    if (score > best.score) best = { vehicle: v, score, reason };
    if (score === 100) break;
  }

  if (best.vehicle && best.score >= minScore) {
    return { id: best.vehicle.id, vehicle: best.vehicle, match: { score: best.score, reason: best.reason } };
  }
  return { id: null, vehicle: null, match: { score: best.score, reason: best.reason } };
}

export async function getUnitForVehicleId(vehicleId) {
  try {
    const v = await fleetioV2(`/vehicles/${vehicleId}`, {}, 'get_vehicle_v2');
    const cands = candidateStringsFromVehicle(v).filter(x => x && !/^[0-9]+$/.test(x));
    return cands[0] || v?.vehicle_number || v?.name || v?.external_id || null;
  } catch (e) {
    try {
      const v = await fleetioV1(`/vehicles/${vehicleId}`, {}, 'get_vehicle_v1');
      const cands = candidateStringsFromVehicle(v);
      return cands[0] || v?.vehicle_number || v?.name || v?.external_id || null;
    } catch {
      return null;
    }
  }
}

export default {
  listAllVehicles,
  getVehicleIdForUnit,
  getUnitForVehicleId,
  buildIndex,
  candidateStringsFromVehicle,
  normalize,
  sanitizeUnitStr
};
