// /api/auth/login.js — Email + password login. Supports 7-day vs 8-hour sessions via 'remember'.
export const config = { runtime: 'nodejs' };

import crypto from 'crypto';
import { sql } from '../db.js';
import { signJWT, setSessionCookie } from '../../auth.js';

function parsePHC(phc) {
  // $scrypt$ln=14,r=8,p=1$<salt_b64>$<key_b64>
  if (!phc || !phc.startsWith('$scrypt$')) return null;
  const parts = phc.split('$').filter(Boolean); // ['scrypt','ln=..,r=..,p=..','salt','key']
  if (parts.length < 4) return null;
  const params = Object.fromEntries(parts[1].split(',').map(s => s.split('=')));
  const ln = Number(params.ln || 14);
  const r  = Number(params.r  || 8);
  const p  = Number(params.p  || 1);
  const salt_b64 = parts[2];
  const key_b64  = parts[3];
  return { ln, r, p, salt: Buffer.from(salt_b64, 'base64'), key: Buffer.from(key_b64, 'base64') };
}
function verifyPasswordPHC(phc, password) {
  const parsed = parsePHC(phc);
  if (!parsed) return false;
  const N = 2 ** parsed.ln;
  const derived = crypto.scryptSync(password, parsed.salt, parsed.key.length, { N, r: parsed.r, p: parsed.p });
  try { return crypto.timingSafeEqual(derived, parsed.key); } catch { return false; }
}
async function readJson(req) {
  return new Promise((resolve, reject) => {
    let data=''; req.setEncoding('utf8');
    req.on('data', c => { data += c; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  let body;
  try { body = await readJson(req); } catch { return res.status(400).json({ ok:false, error:'Bad JSON' }); }

  const emailRaw = (body.email || '').trim();
  const password = body.password || '';
  let remember   = body.remember;
  if (typeof remember === 'string') remember = remember.toLowerCase() === 'true';
  remember = !!remember;

  if (!emailRaw || !password) {
    return res.status(400).json({ ok:false, error:'Missing credentials' });
  }
  const email = emailRaw.toLowerCase();

  try {
    const rows = await sql`
      SELECT a.id AS app_user_id, a.email, a.full_name, a.password_phc, a.role, a.is_active
        FROM app_users a
       WHERE LOWER(a.email) = ${email}
       LIMIT 1
    `;
    const u = rows[0];
    if (!u || !u.password_phc || !verifyPasswordPHC(u.password_phc, password)) {
      return res.status(401).json({ ok:false, error:'Invalid email or password' });
    }
    if (!u.is_active) {
      return res.status(403).json({ ok:false, error:'User inactive' });
    }

    const tr = await sql`SELECT id, is_active FROM technicians WHERE app_user_id=${u.app_user_id} LIMIT 1`;
    const technicianId = tr.length ? tr[0].id : null;

    const sessionSeconds = remember ? (7 * 24 * 60 * 60) : (8 * 60 * 60);

    const token = signJWT({ uid: u.app_user_id, role: u.role || null, tid: technicianId }, { expSeconds: sessionSeconds });
    setSessionCookie(res, token, { maxAgeSeconds: sessionSeconds });

    return res.status(200).json({
      ok: true,
      user: { id: u.app_user_id, email: u.email, full_name: u.full_name, role: u.role || null, technicianId },
      session: { remember, expiresInSeconds: sessionSeconds }
    });
  } catch (e) {
    console.error('POST /api/auth/login failed', e);
    return res.status(500).json({ ok:false, error:'Server error' });
  }
}
