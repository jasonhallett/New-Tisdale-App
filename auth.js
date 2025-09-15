// auth.js — Minimal JWT (HS256) + cookie helpers
import crypto from 'crypto';

const COOKIE_NAME = 'tblapp_session';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64urlJson(obj) { return b64url(JSON.stringify(obj)); }
function fromB64url(str) {
  str = str.replace(/-/g,'+').replace(/_/g,'/'); const pad = str.length % 4; if (pad) str += '='.repeat(4-pad);
  return Buffer.from(str, 'base64');
}

export function signJWT(payload, { expSeconds = 60 * 60 * 12 } = {}) {
  const secret = process.env.APP_JWT_SECRET;
  if (!secret) throw new Error('Missing APP_JWT_SECRET');
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now()/1000);
  const body = { ...payload, iat: now, exp: now + expSeconds };
  const h = b64urlJson(header);
  const p = b64urlJson(body);
  const data = `${h}.${p}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

export function verifyJWT(token) {
  const secret = process.env.APP_JWT_SECRET;
  if (!secret || !token) return null;
  const parts = (token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expected = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  if (!crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(fromB64url(p)); } catch { return null; }
  if (!payload || (payload.exp && Math.floor(Date.now()/1000) > payload.exp)) return null;
  return payload;
}

export function parseCookies(req) {
  const header = req.headers?.cookie || '';
  const out = {};
  header.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > -1) {
      const k = p.slice(0,i).trim();
      const v = p.slice(i+1).trim();
      out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

export function getAuthIdentity(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  const claims = verifyJWT(token);
  if (!claims) return null;
  return { userId: claims.uid, technicianId: claims.tid, role: claims.role || 'technician' };
}

export function setSessionCookie(res, token, { maxAgeSeconds = 60*60*12 } = {}) {
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}