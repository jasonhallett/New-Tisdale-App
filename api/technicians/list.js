// /api/technicians/list.js — list active technicians for dropdown
export const config = { runtime: 'nodejs' };
import { sql } from '../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow','GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const rows = await sql`
      SELECT t.id AS technician_id, a.full_name, a.email
      FROM technicians t
      JOIN app_users a ON a.id = t.app_user_id
      WHERE t.is_active = true AND a.is_active = true
      ORDER BY a.full_name ASC
    `;
    return res.status(200).json({ technicians: rows.map(r => ({
      technicianId: r.technician_id,
      fullName: r.full_name,
      email: r.email
    })) });
  } catch (e) {
    console.error('GET /api/technicians/list failed', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
