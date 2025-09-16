// /api/auth/login.js — login with adjustable session length (8h vs 7d) based on 'remember' flag
export const config = { runtime: 'nodejs' };
import crypto from 'crypto';
import { sql } from '../../db.js';
import { signJWT, setSessionCookie } from '../../auth.js';

function parsePHC(phc) {
  // $scrypt$ln=14,r=8,p=1$<salt_b64>$<key_b64>
  if (!phc || !phc.startsWith('$scrypt$')) return null;
  const parts = phc.split('$').filter(Boolean); // ['scrypt','ln=..,r=..,p=..','salt','key']
  if (parts.length < 4) return null;
  const params = Object.fromEntries(parts[1].split(',').map(s => s.split('=')));
  const salt_b64 = parts[2];
  const key_b64 = parts[3];
  return {
    N: Math.pow(2, Number(params.ln || 14)),
    r: Number(params.r || 8),
    p: Number(params.p || 1),
    salt: Buffer.from(salt_b64, 'base64'),
    key: Buffer.from(key_b64, 'base64')
  };
}

function verifyPasswordPHC(password, phc) {
  const parsed = parsePHC(phc);
  if (!parsed) return false;
  const { N, r, p, salt, key } = parsed;
  const derived = crypto.scryptSync(password, salt, key.length, { N, r, p });
  try { return crypto.timingSafeEqual(derived, key); } catch { return false; }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    } catch (err) { reject(err); }
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body
  let body = '';
  try { body = await readRawBody(req); } catch { return res.status(400).json({ error: 'Bad request' }); }
  let json; try { json = JSON.parse(body); } catch { json = {}; }

  const technicianId = json?.technicianId;
  const password = json?.password || '';
  // remember can be boolean or "true"/"false" string; default false (8h)
  let remember = json?.remember;
  if (typeof remember === 'string') remember = (remember.toLowerCase() === 'true');
  remember = !!remember;

  if (!technicianId || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  try {
    const rows = await sql`
      SELECT a.id AS app_user_id, a.full_name, a.email, a.role, a.password_phc,
             t.id AS technician_id, t.is_active AS technician_active, a.is_active AS user_active
      FROM technicians t
      JOIN app_users a ON a.id = t.app_user_id
      WHERE t.id = ${technicianId}
      LIMIT 1
    `;
    const u = rows?.[0];
    if (!u || !u.password_phc || !verifyPasswordPHC(password, u.password_phc)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!u.user_active || u.technician_active === false) {
      return res.status(403).json({ error: 'User inactive' });
    }

    // Session length: 7 days if remember, else 8 hours
    const sessionSeconds = remember ? (7 * 24 * 60 * 60) : (8 * 60 * 60);

    // Token + cookie durations MATCH to avoid mid-session 401s
    const token = signJWT({ uid: u.app_user_id, tid: u.technician_id, role: u.role }, { expSeconds: sessionSeconds });
    setSessionCookie(res, token, { maxAgeSeconds: sessionSeconds });

    return res.status(200).json({
      ok: true,
      user: { fullName: u.full_name, email: u.email, role: u.role },
      session: { remember, expiresInSeconds: sessionSeconds }
    });
  } catch (e) {
    console.error('POST /api/auth/login failed', e);
    return res.status(500).json({ error: 'Server error' });
  }
}
