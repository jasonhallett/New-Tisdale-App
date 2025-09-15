// db.js — Neon serverless client (ESM)
import { neon } from '@neondatabase/serverless';

const { DATABASE_URL } = process.env;
let _sql = null;
if (DATABASE_URL) {
  _sql = neon(DATABASE_URL);
}
export const sql = (...args) => {
  if (!_sql) {
    const err = new Error('Missing DATABASE_URL env var for Neon/Postgres');
    err.code = 'NO_DATABASE_URL';
    throw err;
  }
  return _sql(...args);
};


export function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  try {
    const match = dataUrl.match(/^data:([^;,]+)(;charset=[^;,]+)?(;base64)?,(.*)$/i);
    if (!match) return null;
    const mime = match[1];
    const isBase64 = !!match[3];
    const tail = match[4] || '';
    const buffer = isBase64
      ? Buffer.from(tail, 'base64')
      : Buffer.from(decodeURIComponent(tail), 'utf8');
    // Back-compat alias (some older code might still read .bytes)
    return { mime, buffer, bytes: buffer };
  } catch (_) {
    return null;
  }
}
}
