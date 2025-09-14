// /api/inspections.js — Save Schedule 4 submissions to Neon/Postgres
// Full file — drop-in replacement.
// - Requires a logged-in user id (from header x-user-id or body.current_user.id). If missing, 400 error (prevents NULLs).
// - Never writes to technician/user tables. Saves everything only to schedule4.
// - Coalesces fields so columns are not NULL unless truly optional.
// - Stores signature image bytes + mime when a Data URL is provided.
// - Keeps technician_id (the logged-in user) and mirrors to app_user_id unless explicitly provided.

export const config = { runtime: 'nodejs' };

import crypto from 'crypto';
import { sql, parseDataUrl } from '../db.js';

/** Primary API handler */
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // ---- Read raw body (so we can accept large base64 signatures) ----
    const rawBody = await readRawBody(req);
    let body;
    try {
      body = JSON.parse(rawBody || '{}');
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    // ---- Determine logged-in user (must exist) ----
    // Prefer explicit header set by frontend; fall back to common body shapes.
    const headerUserId = String(req.headers['x-user-id'] || '').trim() || null;
    const bodyUserId =
      (body?.current_user && (body.current_user.id || body.current_user.user_id)) ||
      body?.user_id ||
      body?.technician_id ||
      body?.app_user_id ||
      null;

    const loggedInUserId = headerUserId || bodyUserId;

    if (!isUuidish(loggedInUserId)) {
      // Hard fail rather than inserting NULLs.
      return res.status(400).json({
        error: 'Missing logged-in user id',
        detail:
          'Provide a valid UUID in header "x-user-id" or body.current_user.id so technician_id is not null.'
      });
    }

    // ---- Extract / normalize fields ----
    const technician_id = loggedInUserId;
    const app_user_id = isUuidish(body?.app_user_id) ? body.app_user_id : (technician_id;) || (form.get("app_user_id") || null)

    // Name and tech info (do NOT persist back to user/technician tables)
    const technician_name =
      sanitizeString(
        body?.technician_name ||
          body?.inspectorName ||
          (body?.technician && (body.technician.name || body.technician.full_name))
      ) || '';

    const technician_sto_registration_num =
      sanitizeString(
        body?.technician_sto_registration_num ||
          body?.stoRegistration ||
          body?.technician?.sto_registration_num
      ) || '';

    const technician_trade_codes = sanitizeArray(
      body?.technician_trade_codes || body?.technician?.trade_codes || []
    );

    // Signature (image data URL -> bytea + mime); save only on this schedule4 row
    const signatureDataUrl =
      body?.signature ||
      body?.signatureDataUrl ||
      body?.technician_signature_image_data_url ||
      null;

    let technician_signature_image = null;
    let technician_signature_image_mime = null;

    if (typeof signatureDataUrl === 'string' && signatureDataUrl.startsWith('data:')) {
      try {
        const parsed = await parseDataUrl(signatureDataUrl);
        technician_signature_image = parsed?.buffer ?? null; // Buffer
        technician_signature_image_mime = sanitizeString(parsed?.mime) || 'image/png';
      } catch {
        // keep nulls for image if parsing fails
      }
    }

    const signature_source = sanitizeString(body?.signatureSource || body?.signature_source || '') || 'applied';

    // Timing
    const performed_at =
      toTimestampUTC(
        body?.performed_at ||
          body?.inspectionDate || // e.g., '2025-09-14'
          body?.performedAt ||
          body?.date
      ) || new Date(); // fallback now (never NULL)

    // Vehicle
    const vehicle_samsara_id =
      sanitizeString(body?.vehicle_samsara_id || body?.samsaraVehicleId || body?.vehicleSamsaraId) || '';
    const vehicle_name =
      sanitizeString(body?.vehicle_name || body?.unitNumber || body?.vehicleName) || '';
    const license_plate =
      sanitizeString(body?.license_plate || body?.licensePlate || body?.plate) || '';

    // Odometer
    const odometer_km = toInteger(
      body?.odometer_km || body?.odometer || body?.odometerKm || body?.odometer_kms
    );
    const odometer_source = sanitizeString(body?.odometer_source || body?.odometerSource) || 'unknown';

    // Expiry / next service
    const expiry_date = toDateOnly(body?.expiry_date || body?.dateExpires || body?.expires);
    const next_service_odometer_km = toInteger(
      body?.next_service_odometer_km || body?.odometerExpires || body?.nextServiceOdometerKm
    );

    // Location / notes
    const location = sanitizeString(body?.location || body?.locationAddress || body?.address) || '';
    const notes = sanitizeString(body?.notes || body?.repairs) || 'N/A';

    // Client submission id (optional) — if not provided, leave null
    const client_submission_id = sanitizeString(body?.client_submission_id) || null;

    // Full payload – store what the client sent (safe, as jsonb)
    // If the payload already has a "signature" data URL, we keep it here too.
    const payload_json = body && typeof body === 'object' ? body : {};

    // ---- Dedupe hash (idempotency) ----
    const dedupe_base = JSON.stringify({
      technician_id,
      vehicle_samsara_id,
      vehicle_name,
      license_plate,
      performed_at: new Date(performed_at).toISOString().slice(0, 19),
      odometer_km: Number.isFinite(odometer_km) ? odometer_km : null
    });
    const dedupe_hash = crypto.createHash('sha256').update(dedupe_base).digest('hex');

    // ---- Insert into schedule4 ----
    const rows = await sql`
      INSERT INTO schedule4 (
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
      )
      VALUES (
        ${technician_id}::uuid,
        ${app_user_id}::uuid,
        ${technician_name},
        ${technician_sto_registration_num || ''},
        ${technician_trade_codes},
        ${technician_signature_image},  -- Buffer | null
        ${technician_signature_image_mime},
        ${signature_source},
        ${performed_at},
        ${vehicle_samsara_id},
        ${vehicle_name},
        ${license_plate},
        ${Number.isFinite(odometer_km) ? odometer_km : null},
        ${odometer_source},
        ${expiry_date},
        ${Number.isFinite(next_service_odometer_km) ? next_service_odometer_km : null},
        ${location},
        ${notes},
        ${payload_json}::jsonb,
        ${client_submission_id},
        ${dedupe_hash}
      )
      ON CONFLICT (dedupe_hash) DO UPDATE SET
        updated_at = NOW()
      RETURNING
        id,
        technician_id,
        app_user_id,
        technician_name,
        technician_sto_registration_num,
        technician_trade_codes,
        technician_signature_image IS NOT NULL AS has_signature,
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
        client_submission_id,
        dedupe_hash,
        created_at,
        updated_at
    `;

    return res.status(200).json({ ok: true, schedule4: rows?.[0] ?? null });
  } catch (err) {
    console.error('inspections.js error:', err);
    return res.status(500).json({ error: 'Server error', detail: String(err?.message || err) });
  }
}

/** ---------- helpers ---------- */

function sanitizeString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function sanitizeArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => sanitizeString(x)).filter(Boolean);
  return [];
}

function isUuidish(v) {
  if (!v || typeof v !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v.trim());
}

function toInteger(v) {
  if (v == null) return null;
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toDateOnly(v) {
  // Accepts "YYYY-MM-DD" or Date-like; returns "YYYY-MM-DD" or null
  try {
    if (!v) return null;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function toTimestampUTC(v) {
  try {
    if (!v) return null;
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  } catch {
    return null;
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', chunk => {
        data += chunk;
        if (data.length > 10_000_000) {
          // prevent body bombs
          reject(new Error('Request too large'));
          req.destroy();
        }
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}
