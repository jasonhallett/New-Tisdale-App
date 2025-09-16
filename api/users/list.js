// /api/users/list.js — GET list users; filter by role(s) via ?role=TECHNICIAN,ADMIN
export const config = { runtime: 'nodejs' };
import { sql } from '../../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow','GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const url = new URL(req.url, 'http://x');
    const roleParam = url.searchParams.get('role');
    const roles = (roleParam || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    let rows;
    if (roles.length) {
      rows = await sql`
        SELECT a.id, a.email, a.full_name, a.role AS legacy_role, a.is_active,
               (SELECT array_agg(ur.role_name ORDER BY ur.role_name) FROM user_roles ur WHERE ur.user_id=a.id) AS roles,
               t.id AS technician_id, t.sto_registration_number, t.trade_codes, t.is_active AS technician_active
          FROM app_users a
          LEFT JOIN technicians t ON t.app_user_id = a.id
         WHERE a.is_active = true
           AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id=a.id AND ur.role_name = ANY(${roles}::text[]))
         ORDER BY a.full_name ASC
      `;
    } else {
      rows = await sql`
        SELECT a.id, a.email, a.full_name, a.role AS legacy_role, a.is_active,
               (SELECT array_agg(ur.role_name ORDER BY ur.role_name) FROM user_roles ur WHERE ur.user_id=a.id) AS roles,
               t.id AS technician_id, t.sto_registration_number, t.trade_codes, t.is_active AS technician_active
          FROM app_users a
          LEFT JOIN technicians t ON t.app_user_id = a.id
         WHERE a.is_active = true
         ORDER BY a.full_name ASC
      `;
    }

    const users = rows.map(r => ({
      id: r.id, email: r.email, fullName: r.full_name, isActive: r.is_active,
      legacyRole: r.legacy_role, roles: r.roles || [],
      technician: r.technician_id ? {
        technicianId: r.technician_id,
        stoRegistrationNumber: r.sto_registration_number,
        tradeCodes: r.trade_codes || [],
        isActive: r.technician_active
      } : null,
    }));
    return res.status(200).json({ ok:true, users });
  } catch (e) {
    console.error('GET /api/users/list failed', e);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
}
