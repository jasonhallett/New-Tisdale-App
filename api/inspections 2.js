// /api/inspections.js — Save/Update Schedule 4 submissions to Neon/Postgres
// Single endpoint (POST): create if no id, update if id is provided.
export const config = { runtime: 'nodejs' };

import crypto from 'crypto';
import { sql, parseDataUrl } from '../db.js';
import { getAuthIdentity } from '../auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Require authenticated session so we can attach technician/app user IDs
  const auth = getAuthIdentity(req);
  if (!auth?.userId || !auth?.technicianId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ---- Load technician details (fallbacks) ----
  let techRow = null;
  try {
    const t = await sql`
      SELECT t.sto_registration_number,
             t.trade_codes,
             a.full_name
        FROM technicians t
        JOIN app_users a ON a.id = t.app_user_id
       WHERE t.id = ${auth.technicianId}
       LIMIT 1
    `;
    techRow = t[0] || null;
  } catch (e) {
    console.error('Lookup technician failed:', e);
  }

  // ---- Read body safely ----
  let rawBody = '';
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Failed to read body', details: String(e?.message || e) });
  }

  let body;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    body = typeof req.body === 'object' && req.body ? req.body : { payload: rawBody };
  }

  // Accept both top-level and payload.* inputs
  const payload = body?.payload || body?.data || body || {};
  const clientSubmissionId = strish(pick(payload, ['clientSubmissionId', 'client_submission_id'])) ?? strish(body.client_submission_id);
  const dedupeHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  // If the user re-submits identical payload for the same record, normalize N/A for drum-only checks
  try {
    const checklist = payload && payload.checklist;
    const discFlags = [
      payload?.rSteerBrake, payload?.rDriveBrake, payload?.rTagBrake,
      payload?.lSteerBrake, payload?.lDriveBrake, payload?.lTagBrake
    ];
    const isDisc = discFlags.some(v => String(v ?? '').toLowerCase() === 'disc');
    if (isDisc && checklist && typeof checklist === 'object') {
      const L1 = 'Brake pushrod stroke is at or beyond the adjustment limit';
      const L2 = "Wedge brake shoe movement exceeds manufacturer's specified limit";
      if (L1 in checklist) checklist[L1] = 'na';
      if (L2 in checklist) checklist[L2] = 'na';
    }
  } catch (_) {}

  // ---------- helpers to read from payload OR top-level ----------
  const pickAny = (payloadKeys = [], bodyKeys = []) =>
    (pick(payload, payloadKeys) ?? pick(body, bodyKeys));

  // Technician / vehicle / misc fields (prefer payload, then top-level, then DB fallback)
  const technicianNamePayload =
    pick(payload, ['technicianName', 'inspectorName', 'inspector', 'name']) ?? pick(body, ['technician_name']);
  const stoPayload =
    pick(payload, ['technicianSTO', 'stoRegistrationNumber', 'sto', 'stoNumber']) ?? pick(body, ['technician_sto_registration_num']);
  const tradeCodesPayload =
    arrish(pick(payload, ['technicianTradeCodes', 'tradeCodes']) ?? pick(body, ['technician_trade_codes']));

  const technicianName =
    technicianNamePayload || techRow?.full_name || 'Unknown';
  const sto =
    (stoPayload ?? null) !== null && `${stoPayload}`.trim() !== ''
      ? `${stoPayload}`.trim()
      : (techRow?.sto_registration_number ?? null);
  const tradeCodes =
    (Array.isArray(tradeCodesPayload) && tradeCodesPayload.length > 0)
      ? tradeCodesPayload
      : (Array.isArray(techRow?.trade_codes) ? techRow.trade_codes : []);

  let vehicleId = strish(
    pickAny(
      ['vehicleId','selectedVehicleId','samsaraVehicleId','vehicle_id','unitId','selectedUnitId'],
      ['vehicle_samsara_id']
    )
  );
  if (!vehicleId && typeof payload?.selectedVehicle === 'object') {
    vehicleId = strish(payload.selectedVehicle.id || payload.selectedVehicle.vehicleId || payload.selectedVehicle.unitId);
  }

  const vehicleName = pickAny(['vehicleName','unit','unitNumber','unitName'], ['vehicle_name']) || null;
  const licensePlate = pickAny(['licensePlate','plate','plateNumber'], ['license_plate']) || null;

  const odometerKm = intish(pickAny(['odometerKm','odometerKM','odometer'], ['odometer_km']));
  const samsaraOdometerKm = intish(pickAny(['samsaraOdometerKm','samsara_odometer_km','samsaraOdometerKM'], ['samsara_odometer_km']));

  // Canonical odometer source inference: samsara | user_entered | unknown --> DB enum: gps|manual|unknown
  const hintCanonical = enumish(pick(payload, ['odometerSource']), ['samsara','user_entered','unknown'], null);
  let odometerSourceCanonical = 'unknown';
  if (hintCanonical) {
    odometerSourceCanonical = hintCanonical;
  } else if (samsaraOdometerKm != null && odometerKm != null) {
    odometerSourceCanonical = (samsaraOdometerKm === odometerKm) ? 'samsara' : 'user_entered';
  } else if (samsaraOdometerKm != null) {
    odometerSourceCanonical = 'samsara';
  }
  const odometerSource = (
    odometerSourceCanonical === 'samsara' ? 'gps' :
    odometerSourceCanonical === 'user_entered' ? 'manual' :
    'unknown'
  );

  const expiryDate = dateish(pickAny(['expiryDate','inspectionDate','dateExpires'], ['expiry_date']));
  const nextServiceOdometerKm = intish(pickAny(['nextServiceOdometerKm','nextServiceOdometer','odometerExpires'], ['next_service_odometer_km']));

  const location = pickAny(['location','locationAddress','shopLocation','facility'], ['location']) || null;
  const notes = pickAny(['notes','repairs','repairNotes','comments'], ['notes']) || null;

  const performedAt =
    datetimeish(pickAny(['performedAt','timestamp','submittedAt','dateTime','inspectionDate','date'], ['performed_at'])) || new Date();

  const sigField = pickAny(['signature','signatureDataUrl','signatureDataURL'], ['signature']);
  const sigParsed = parseDataUrl(sigField);
  const signatureBytes = sigParsed?.bytes || null;
  const signatureMime = sigParsed?.mime || (sigField ? 'image/png' : null);
  const signatureSource = enumish(pickAny(['signatureSource'], ['signature_source']), ['drawn','saved','applied'], 'drawn');

  const id = pickAny([], ['id']); // accept top-level id for updates

  try {
    // -------- UPDATE path (body.id present) --------
    if (id != null && `${id}`.trim() !== '') {
      const rows = await sql`
        UPDATE schedule4_inspections
           SET technician_name = ${technicianName},
               technician_sto_registration_num = ${sto},
               technician_trade_codes = ${tradeCodes},
               technician_signature_image = COALESCE(${signatureBytes}, technician_signature_image),
               technician_signature_image_mime = COALESCE(${signatureMime}, technician_signature_image_mime),
               signature_source = ${signatureSource},
               performed_at = COALESCE(${toIso(performedAt)}, performed_at),
               vehicle_samsara_id = ${vehicleId},
               vehicle_name = ${vehicleName},
               license_plate = ${licensePlate},
               odometer_km = ${odometerKm},
               odometer_source = ${odometerSource},
               expiry_date = ${expiryDate},
               next_service_odometer_km = ${nextServiceOdometerKm},
               location = ${location},
               notes = ${notes},
               payload_json = ${payload}
         WHERE id = ${id}
         RETURNING id
      `;
      const row = rows?.[0] || null;
      if (!row) return res.status(404).json({ error: 'Inspection not found', id });
      return res.status(200).json({ ok: true, id: row.id });
    }

    // -------- CREATE path (no id) --------
    const rows = await sql`
      INSERT INTO schedule4_inspections (
        technician_id,
        app_user_id,
        technician_name,
        technician_sto_registration_num,
        technician_trade_codes,
        technician_signature_image,
        technician_signature_image_mime,
        signature_source,
        performed_at,
        vehicle_samsara_id,
        vehicle_name,
        license_plate,
        odometer_km,
        odometer_source,
        expiry_date,
        next_service_odometer_km,
        location,
        notes,
        payload_json,
        client_submission_id,
        dedupe_hash
      ) VALUES (
        ${auth.technicianId},
        ${auth.userId},
        ${technicianName},
        ${sto},
        ${tradeCodes},
        ${signatureBytes},
        ${signatureMime},
        ${signatureSource},
        ${toIso(performedAt)},
        ${vehicleId},
        ${vehicleName},
        ${licensePlate},
        ${odometerKm},
        ${odometerSource},
        ${expiryDate},
        ${nextServiceOdometerKm},
        ${location},
        ${notes},
        ${payload},
        ${clientSubmissionId},
        ${dedupeHash}
      )
      ON CONFLICT (dedupe_hash) DO NOTHING
      RETURNING id
    `;

    let newId = rows?.[0]?.id || null;

    // If dedup blocked the insert, look up the existing row’s id and return it
    if (!newId) {
      const found = await sql`
        SELECT id FROM schedule4_inspections
         WHERE dedupe_hash = ${dedupeHash}
         ORDER BY created_at DESC
         LIMIT 1
      `;
      newId = found?.[0]?.id || null;
    }

    if (!newId) {
      return res.status(500).json({ error: 'Insert did not return an id (and no existing id was found).' });
    }

    return res.status(201).json({ ok: true, id: newId });
  } catch (e) {
    console.error('Save schedule4 failed:', e);
    const msg = e?.message || String(e);
    return res.status(500).json({ error: 'Database save failed', details: msg });
  }
}

/* ---------------- helpers ---------------- */

function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}
function strish(v) { return v == null ? null : String(v); }
function intish(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }
function arrish(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  return String(v).split(/[;,]/).map(s => s.trim()).filter(Boolean);
}
function enumish(v, allowed, dflt) {
  v = v && String(v).toLowerCase();
  return allowed.includes(v) ? v : dflt;
}
function dateish(v) {
  if (!v) return null;
  try {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0,10) : null;
  } catch { return null; }
}
function datetimeish(v) {
  if (!v) return null;
  try {
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  } catch { return null; }
}
function toIso(v) {
  return (v && typeof v.toISOString === 'function') ? v.toISOString() : v;
}
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { data += chunk; if (data.length > 5_000_000) req.destroy(); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    } catch (err) { reject(err); }
  });
}