// /api/users/update-roles.js — PATCH/POST update roles for a user
export const config = { runtime: 'nodejs' };
import { sql } from '../../db.js';

export default async function handler(req, res) {
  if (req.method !== 'PATCH' && req.method !== 'POST') {
    res.setHeader('Allow','PATCH, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  let body=''; req.setEncoding('utf8');
  await new Promise((resolve,reject)=>{ req.on('data',c=>{body+=c; if(body.length>1_000_000) req.destroy();}); req.on('end',resolve); req.on('error',reject); });
  let json={}; try{ json=JSON.parse(body||'{}'); }catch{}

  const user_id = json.user_id;
  const roles = Array.isArray(json.roles) ? json.roles.map(r => String(r||'').toUpperCase().trim()).filter(Boolean) : [];
  const replaceRoles = (json.replaceRoles === undefined) ? true : !!json.replaceRoles;

  if (!user_id || !/^[0-9a-fA-F-]{36}$/.test(user_id)) {
    return res.status(400).json({ error: 'Valid user_id (UUID) required' });
  }

  try {
    const exists = await sql`SELECT 1 FROM app_users WHERE id=${user_id} LIMIT 1`;
    if (!exists.length) return res.status(404).json({ error: 'User not found' });

    if (roles.length) {
      await sql`INSERT INTO roles (role_name) SELECT role_name FROM unnest(${roles}::text[]) AS role_name ON CONFLICT DO NOTHING`;
    }
    if (replaceRoles) {
      await sql`DELETE FROM user_roles WHERE user_id=${user_id}`;
    }
    if (roles.length) {
      await sql`
        INSERT INTO user_roles (user_id, role_name)
        SELECT ${user_id}, role_name FROM unnest(${roles}::text[]) AS role_name
        ON CONFLICT DO NOTHING
      `;
    }

    const roleRows = await sql`SELECT role_name FROM user_roles WHERE user_id=${user_id} ORDER BY role_name`;
    return res.status(200).json({ ok:true, roles: roleRows.map(r=>r.role_name) });
  } catch (e) {
    console.error('PATCH /api/users/update-roles failed', e);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
}
