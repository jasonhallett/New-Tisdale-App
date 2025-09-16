// /api/users/create.js — POST upsert app_user + assign roles; upsert technician if TECHNICIAN
// Assumes db.js is at the project root (../../db.js).
export const config = { runtime: 'nodejs' };

import crypto from 'crypto';
import { sql } from '../../db.js';

// helpers
function toPHCScrypt(password) {
  const ln = 14, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, { N: 2 ** ln, r, p });
  return `$scrypt$ln=${ln},r=${r},p=${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function columnExists(table, col) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=${table} AND column_name=${col}
     LIMIT 1
  `;
  return !!rows.length;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
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
  try { json = JSON.parse(body || '{}'); }
  catch { return res.status(400).json({ ok: false, error: 'Bad JSON' }); }

  const email = (json.email || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Valid email is required' });
  }

  const full_name    = json.full_name?.trim() || null;
  const phone        = (json.phone || '').trim() || null; // optional; only saved if column exists
  const is_active    = (json.is_active === undefined) ? true : !!json.is_active;
  const roles        = Array.isArray(json.roles) ? json.roles.map(r => String(r||'').toUpperCase().trim()).filter(Boolean) : [];
  const replaceRoles = !!json.replaceRoles;

  // Optional password hashing to PHC ($scrypt$...) supported by your login
  let password_phc = (json.password_phc || '').trim() || null;
  if (!password_phc && json.password) password_phc = toPHCScrypt(json.password);

  try {
    const hasPhone = await columnExists('app_users', 'phone');

    // 1) Upsert into app_users (no pgcrypto required)
    let app_user_id;
    const existing = await sql`SELECT id FROM app_users WHERE email = ${email} LIMIT 1`;

    if (existing.length) {
      app_user_id = existing[0].id;

      const sets = [
        sql`full_name = ${full_name}`,
        sql`is_active = COALESCE(${is_active}, is_active)`,
        sql`updated_at = now()`,
      ];
      if (password_phc !== null) sets.splice(1, 0, sql`password_phc = ${password_phc}`);
      if (hasPhone)              sets.splice(1, 0, sql`phone = ${phone}`);

      await sql`UPDATE app_users SET ${sql.join(sets, sql`, `)} WHERE id = ${app_user_id}`;
    } else {
      app_user_id = crypto.randomUUID();

      if (hasPhone) {
        await sql`
          INSERT INTO app_users (id, email, full_name, phone, password_phc, is_active, created_at, updated_at)
          VALUES (${app_user_id}, ${email}, ${full_name}, ${phone}, ${password_phc}, ${is_active}, now(), now())
        `;
      } else {
        await sql`
          INSERT INTO app_users (id, email, full_name, password_phc, is_active, created_at, updated_at)
          VALUES (${app_user_id}, ${email}, ${full_name}, ${password_phc}, ${is_active}, now(), now())
        `;
      }
    }

    // 2) Ensure roles exist, then assign (requires RBAC migration)
    if (roles.length) {
      try {
        await sql`
          INSERT INTO roles (role_name)
          SELECT role_name FROM unnest(${roles}::text[]) AS role_name
          ON CONFLICT DO NOTHING
        `;
      } catch (e) {
        if (String(e?.message || '').includes('relation "roles" does not exist')) {
          return res.status(500).json({ ok: false, error: 'DB schema missing: table "roles" not found. Run the RBAC migration SQL.' });
        }
        throw e;
      }

      if (replaceRoles) {
        await sql`DELETE FROM user_roles WHERE user_id = ${app_user_id}`;
      }

      try {
        await sql`
          INSERT INTO user_roles (user_id, role_name)
          SELECT ${app_user_id}, role_name FROM unnest(${roles}::text[]) AS role_name
          ON CONFLICT DO NOTHING
        `;
      } catch (e) {
        if (String(e?.message || '').includes('relation "user_roles" does not exist')) {
          return res.status(500).json({ ok: false, error: 'DB schema missing: table "user_roles" not found. Run the RBAC migration SQL.' });
        }
        throw e;
      }
    }

    // 3) Upsert technicians row if TECHNICIAN selected
    if (roles.includes('TECHNICIAN') && json.technicianProfile) {
      const tp = json.technicianProfile || {};
      const trade_codes = Array.isArray(tp.trade_codes)
        ? tp.trade_codes
        : (typeof tp.trade_codes === 'string'
            ? tp.trade_codes.split(',').map(s => s.trim()).filter(Boolean)
            : []);

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
        const tech_id = crypto.randomUUID();
        await sql`
          INSERT INTO technicians (id, app_user_id, sto_registration_number, trade_codes, default_carrier, default_station_address, is_active, created_at, updated_at)
          VALUES (${tech_id}, ${app_user_id}, ${tp.sto_registration_number}, ${trade_codes}::text[], ${tp.default_carrier}, ${tp.default_station_address}, true, now(), now())
        `;
      }
    }

    // 4) Return final state (with phone if present)
    const phoneCol = (await columnExists('app_users', 'phone'))
      ? sql`phone`
      : sql`NULL::text AS phone`;

    const userRow  = (await sql`
      SELECT id, email, full_name, ${phoneCol}, role, is_active
        FROM app_users
       WHERE id = ${app_user_id}
    `)[0];

    const roleRows = await sql`SELECT role_name FROM user_roles WHERE user_id = ${app_user_id} ORDER BY role_name`;

    const tech     = await sql`
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
