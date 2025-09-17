// /api/inspections.js — Save Schedule 4 submissions to Neon/Postgres (with DB fallback for STO / trade codes)
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

  // ---- Load technician details from DB to use as fallback (source of truth) ----
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
    // Non-fatal; we’ll just skip DB fallback if this fails
    console.error('Lookup technician failed:', e);
  }

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

  const payload = body?.payload || body?.data || body || {};
  const clientSubmissionId = strish(pick(payload, ['clientSubmissionId', 'client_submission_id']));
  const dedupeHash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  /* Normalize NA for drum-only checks if disc brakes are used */
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

  // --- Technician / vehicle / misc fields ---

  // Prefer payload values when present; otherwise fallback to DB values
  const technicianNamePayload =
    pick(payload, ['technicianName', 'inspectorName', 'inspector', 'name']);
  const stoPayload =
    pick(payload, ['technicianSTO', 'stoRegistrationNumber', 'sto', 'stoNumber']);
  const tradeCodesPayload =
    arrish(pick(payload, ['technicianTradeCodes', 'tradeCodes']));

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

  let vehicleId = strish(pick(payload, ['vehicleId','selectedVehicleId','samsaraVehicleId','vehicle_id','unitId','selectedUnitId']));
  if (!vehicleId && typeof payload?.selectedVehicle === 'object') {
    vehicleId = strish(payload.selectedVehicle.id || payload.selectedVehicle.vehicleId || payload.selectedVehicle.unitId);
  }
  const vehicleName = pick(payload, ['vehicleName', 'unit', 'unitNumber', 'unitName']) || null;
  const licensePlate = pick(payload, ['licensePlate', 'plate', 'plateNumber']) || null;

  const odometerKm = intish(pick(payload, ['odometerKm', 'odometerKM', 'odometer']));
  const samsaraOdometerKm = intish(pick(payload, ['samsaraOdometerKm', 'samsara_odometer_km', 'samsaraOdometerKM']));

  // Canonical odometer source inference: samsara | user_entered | unknown
  const hintCanonical = enumish(pick(payload, ['odometerSource']), ['samsara','user_entered','unknown'], null);
  let odometerSourceCanonical = 'unknown';
  if (hintCanonical) {
    odometerSourceCanonical = hintCanonical;
  } else if (samsaraOdometerKm != null && odometerKm != null) {
    odometerSourceCanonical = (samsaraOdometerKm === odometerKm) ? 'samsara' : 'user_entered';
  } else if (samsaraOdometerKm != null) {
    odometerSourceCanonical = 'samsara';
  }
  // Map canonical → DB enum (gps|manual|unknown)
  const odometerSource = (
    odometerSourceCanonical === 'samsara' ? 'gps' :
    odometerSourceCanonical === 'user_entered' ? 'manual' :
    'unknown'
  );

  const expiryDate = dateish(pick(payload, ['expiryDate', 'inspectionDate', 'dateExpires']));
  const nextServiceOdometerKm = intish(pick(payload, ['nextServiceOdometerKm', 'nextServiceOdometer', 'odometerExpires']));

  const location = pick(payload, ['location', 'locationAddress', 'shopLocation', 'facility']) || null;
  const notes = pick(payload, ['notes', 'repairs', 'repairNotes', 'comments']) || null;

  const performedAt = datetimeish(pick(payload, ['performedAt', 'timestamp', 'submittedAt', 'dateTime', 'inspectionDate', 'date'])) || new Date();

  const sigField = pick(payload, ['signature', 'signatureDataUrl', 'signatureDataURL']);
  const sigParsed = parseDataUrl(sigField);
  const signatureBytes = sigParsed?.bytes || null;
  const signatureMime = sigParsed?.mime || (sigField ? 'image/png' : null);
  const signatureSource = enumish(pick(payload, ['signatureSource']), ['drawn', 'saved', 'applied'], 'drawn');

  try {
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
        ${odometerSource},              -- mapped to enum: gps/manual/unknown
        ${expiryDate},
        ${nextServiceOdometerKm},
        ${location},
        ${notes},
        ${payload},
        ${clientSubmissionId},
        ${dedupeHash}
      )
      ON CONFLICT (dedupe_hash) DO NOTHING
      RETURNING id, created_at, technician_id, app_user_id, technician_sto_registration_num, technician_trade_codes, odometer_source;
    `;

    const row = rows?.[0] || null;
    return res.status(201).json({
      ok: true,
      id: row?.id,
      createdAt: row?.created_at,
      technicianId: row?.technician_id,
      appUserId: row?.app_user_id,
      sto: row?.technician_sto_registration_num ?? sto ?? null,
      tradeCodes: row?.technician_trade_codes ?? tradeCodes ?? [],
      odometerSource
    });
  } catch (e) {
    console.error('Insert schedule4 failed:', e);
    const msg = e?.message || String(e);
    return res.status(500).json({ error: 'Database insert failed', details: msg });
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
