// /api/auth/logout.js — clear session cookie and return 200
export const config = { runtime: 'nodejs' };
import { clearSessionCookie } from '../../auth.js';

export default async function handler(req, res) {
  // We accept GET and POST for convenience
  try {
    clearSessionCookie(res);
  } catch {}
  res.status(200).json({ ok: true });
}
