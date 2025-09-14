// /api/technicians/me.js — Authenticated profile for current technician
export const config = { runtime: 'nodejs' };

import { sql } from '../../db.js';
import { getAuthIdentity } from '../../auth.js';

function toDataUrl(mime, buf) {
  if (!buf || !mime) return null;
  const b64 = Buffer.from(buf).toString('base64');
  return `data:${mime};base64,${b64}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = getAuthIdentity(req);
  if (!auth?.userId || !auth?.technicianId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const rows = await sql`
      SELECT
        t.id AS technician_id,
        a.id AS app_user_id,
        a.full_name,
        a.email,
        a.role,
        t.sto_registration_number,
        t.trade_codes,
        t.signature_image,
        t.signature_image_mime,
        t.signature_last_updated,
        t.is_active
      FROM technicians t
      JOIN app_users a ON a.id = t.app_user_id
      WHERE a.id = ${auth.userId} AND t.id = ${auth.technicianId} AND t.is_active = true AND a.is_active = true
      LIMIT 1
    `;
    if (!rows.length) {
      return res.status(404).json({ error: 'Technician profile not found' });
    }
    const r = rows[0];
    return res.status(200).json({
      technicianId: r.technician_id,
      appUserId: r.app_user_id,
      fullName: r.full_name,
      email: r.email,
      role: r.role,
      stoRegistrationNumber: r.sto_registration_number,
      tradeCodes: r.trade_codes,
      signatureDataUrl: toDataUrl(r.signature_image_mime, r.signature_image),
      signatureLastUpdated: r.signature_last_updated,
      isActive: r.is_active,
    });
  } catch (e) {
    console.error('GET /api/technicians/me failed', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
