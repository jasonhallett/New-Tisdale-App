// /api/users/create.js — POST upsert app_user + roles + technician (FIXED)
export const config = { runtime: 'nodejs' };
import crypto from 'crypto';
import { sql } from '../../db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Read JSON body safely
  let body = '';
  req.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    req.on('data', c => { body += c; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', resolve);
    req.on('error', reject);
  });
  let json = {};
  try { json = JSON.parse(body || '{}'); } catch { return res.status(400).json({ error: 'Bad JSON' }); }

  const email = (json.email || '').trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }

  const full_name = json.full_name?.trim() || null;
  const phone = json.phone?.trim() || null;
  const is_active = (json.is_active === undefined) ? true : !!json.is_active;
  const roles = Array.isArray(json.roles) ? json.roles.map(r => String(r||'').toUpperCase().trim()).filter(Boolean) : [];
  const replaceRoles = !!json.replaceRoles;

  // Optional password hash to PHC ($scrypt$...)
  let password_phc = (json.password_phc || '').trim() || null;
  if (!password_phc && json.password) password_phc = toPHCScrypt(json.password);

  try {
    // Upsert app_user by email
    const existing = await sql`SELECT id FROM app_users WHERE email = ${email} LIMIT 1`;
    let app_user_id;
    if (existing.length) {
      app_user_id = existing[0].id;
      await sql`
        UPDATE app_users
           SET full_name = ${full_name},
               phone = ${phone},
               ${password_phc !== null ? sql`password_phc = ${password_phc},` : sql``}
               is_active = COALESCE(${is_active}, is_active),
               updated_at = now()
         WHERE id = ${app_user_id}
      `;
    } else {
      const rows = await sql`
        INSERT INTO app_users (id, email, full_name, phone, password_phc, is_active, created_at, updated_at)
        VALUES (gen_random_uuid(), ${email}, ${full_name}, ${phone}, ${password_phc}, ${is_active}, now(), now())
        RETURNING id
      `;
      app_user_id = rows[0].id;
    }

    // Ensure roles and assign
    if (roles.length) {
      await sql`INSERT INTO roles (role_name) SELECT role_name FROM unnest(${roles}::text[]) AS role_name ON CONFLICT DO NOTHING`;
      if (replaceRoles) await sql`DELETE FROM user_roles WHERE user_id = ${app_user_id}`;
      await sql`
        INSERT INTO user_roles (user_id, role_name)
        SELECT ${app_user_id}, role_name FROM unnest(${roles}::text[]) AS role_name
        ON CONFLICT DO NOTHING
      `;
    }

    // Technician profile upsert if TECHNICIAN role included
    if (roles.includes('TECHNICIAN') && json.technicianProfile) {
      const tp = json.technicianProfile;
      const trade_codes = Array.isArray(tp.trade_codes)
        ? tp.trade_codes
        : (typeof tp.trade_codes === 'string' ? tp.trade_codes.split(',').map(s => s.trim()).filter(Boolean) : []);
      const existsTech = await sql`SELECT id FROM technicians WHERE app_user_id = ${app_user_id} LIMIT 1`;
      if (existsTech.length) {
        await sql`
          UPDATE technicians
             SET sto_registration_number = COALESCE(${tp.sto_registration_number}, sto_registration_number),
                 trade_codes = COALESCE(${trade_codes}::text[], trade_codes),
                 default_carrier = COALESCE(${tp.default_carrier}, default_carrier),
                 default_station_address = COALESCE(${tp.default_station_address}, default_station_address),
                 is_active = true,
                 updated_at = now()
           WHERE app_user_id = ${app_user_id}
        `;
      } else {
        await sql`
          INSERT INTO technicians (id, app_user_id, sto_registration_number, trade_codes, default_carrier, default_station_address, is_active, created_at, updated_at)
          VALUES (gen_random_uuid(), ${app_user_id}, ${tp.sto_registration_number}, ${trade_codes}::text[], ${tp.default_carrier}, ${tp.default_station_address}, true, now(), now())
        `;
      }
    }

    // Final state
    const userRow = (await sql`SELECT id, email, full_name, phone, role, is_active FROM app_users WHERE id = ${app_user_id}`)[0];
    const roleRows = await sql`SELECT role_name FROM user_roles WHERE user_id = ${app_user_id} ORDER BY role_name`;
    const tech = await sql`
      SELECT sto_registration_number, trade_codes, default_carrier, default_station_address, is_active
        FROM technicians WHERE app_user_id = ${app_user_id} LIMIT 1
    `;

    return res.status(200).json({
      ok: true,
      user: {
        ...userRow,
        roles: roleRows.map(r => r.role_name),
        technician: tech[0] || null
      }
    });
  } catch (e) {
    console.error('POST /api/users/create failed', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}

function toPHCScrypt(password) {
  const ln = 14, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 2 ** ln, r, p });
  return `$scrypt$ln=${ln},r=${r},p=${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
