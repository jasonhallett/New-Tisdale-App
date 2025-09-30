// /api/roles/list.js — GET roles
export const config = { runtime: 'nodejs' };
import { sql } from '../db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow','GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const rows = await sql`SELECT role_name, description FROM roles ORDER BY role_name ASC`;
    return res.status(200).json({ ok: true, roles: rows });
  } catch (e) {
    console.error('GET /api/roles/list failed', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
