// /api/inspections.js — Save Schedule 4 submissions to Neon/Postgres
export const config = { runtime: 'nodejs' };

import { sql, parseDataUrl } from '../db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let rawBody = '';
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Failed to read body', details: String(e?.message || e) });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = { payload: rawBody };
  }

  const payload = body?.payload || body?.data || body || {};
  /* DISC BRAKES NA NORMALIZATION */
  try {
    const checklist = payload && payload.checklist;
    const discFlags = [
      payload?.rSteerBrake, payload?.rDriveBrake, payload?.rTagBrake,
      payload?.lSteerBrake, payload?.lDriveBrake, payload?.lTagBrake
    ];
    const isDisc = Array.isArray(discFlags) && discFlags.some(v => String(v||'').toLowerCase() === 'disc');
    if (isDisc && checklist && typeof checklist === 'object') {
      const L1 = 'Brake pushrod stroke is at or beyond the adjustment limit';
      const L2 = "Wedge brake shoe movement exceeds manufacturer's specified limit";
      if (checklist[L1] && checklist[L1] !== 'na') checklist[L1] = 'na';
      if (checklist[L2] && checklist[L2] !== 'na') checklist[L2] = 'na';
    }
  } catch (_) {}

  const technicianName = pick(payload, ['technicianName', 'inspectorName', 'inspector', 'name']) || 'Unknown';
  const sto = pick(payload, ['technicianSTO', 'stoRegistrationNumber', 'sto', 'stoNumber']) || null;
  const tradeCodes = arrish(pick(payload, ['technicianTradeCodes', 'tradeCodes']));

  const vehicleId = strish(pick(payload, ['vehicleId', 'selectedVehicleId', 'samsaraVehicleId']));
  const vehicleName = pick(payload, ['vehicleName', 'unit', 'unitNumber', 'unitName']) || null;
  const licensePlate = pick(payload, ['licensePlate', 'plate', 'plateNumber']) || null;

  const odometerKm = intish(pick(payload, ['odometerKm', 'odometerKM', 'odometer']));
  const odometerSource = enumish(pick(payload, ['odometerSource']), ['obd', 'gps', 'manual', 'unknown'], 'unknown');

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
        payload_json
      ) VALUES (
        NULL,
        NULL,
        ${technicianName},
        ${sto},
        ${tradeCodes},
        ${signatureBytes},
        ${signatureMime},
        ${signatureSource},
        ${performedAt?.toISOString?.() || performedAt},
        ${vehicleId},
        ${vehicleName},
        ${licensePlate},
        ${odometerKm},
        ${odometerSource},
        ${expiryDate},
        ${nextServiceOdometerKm},
        ${location},
        ${notes},
        ${payload}
      )
      RETURNING id, created_at;
    `;

    const row = rows?.[0] || null;
    return res.status(201).json({ ok: true, id: row?.id, createdAt: row?.created_at });
  } catch (e) {
    console.error('Insert schedule4 failed:', e);
    const msg = e?.message || String(e);
    return res.status(500).json({ error: 'Database insert failed', details: msg });
  }
}

// helpers
function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return undefined;
}
function strish(v) { return v == null ? null : String(v); }
function intish(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : null; }
function arrish(v) { return Array.isArray(v) ? v : (v ? String(v).split(/[;,]/).map(s => s.trim()).filter(Boolean) : []); }
function enumish(v, allowed, dflt) { v = v && String(v).toLowerCase(); return allowed.includes(v) ? v : dflt; }
function dateish(v) {
  if (!v) return null;
  try { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString().slice(0,10) : null; } catch { return null; }
}
function datetimeish(v) {
  if (!v) return null;
  try { const d = new Date(v); return Number.isFinite(d.getTime()) ? d : null; } catch { return null; }
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
