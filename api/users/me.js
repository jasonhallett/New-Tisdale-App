// /api/users/me.js — return current authenticated user, incl. roles and optional technician profile
export const config = { runtime: 'nodejs' };

import { sql } from './db.js';
import { getAuthIdentity } from '../../auth.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const ident = getAuthIdentity(req);
    if (!ident?.userId) return res.status(401).json({ error: 'Unauthorized' });

    const urows = await sql`
      SELECT id, email, full_name, role, is_active
        FROM app_users WHERE id = ${ident.userId} LIMIT 1
    `;
    if (!urows.length) return res.status(404).json({ error: 'User not found' });
    const u = urows[0];

    let roles = [];
    try {
      const rrows = await sql`SELECT role_name FROM user_roles WHERE user_id = ${u.id} ORDER BY role_name`;
      roles = rrows.map(r => r.role_name);
    } catch {}

    const trows = await sql`
      SELECT sto_registration_number, trade_codes, default_carrier, default_station_address, is_active
        FROM technicians WHERE app_user_id = ${u.id} LIMIT 1
    `;
    const technician = trows[0] || null;

    return res.status(200).json({
      ok: true,
      user: {
        id: u.id,
        email: u.email,
        full_name: u.full_name,
        role: u.role,
        roles,
        technician
      }
    });
  } catch (e) {
    console.error('GET /api/users/me failed', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
