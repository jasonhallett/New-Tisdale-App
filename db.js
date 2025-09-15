// db.js — Neon serverless client (ESM)
import { neon } from '@neondatabase/serverless';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  throw new Error('Missing DATABASE_URL env var for Neon/Postgres');
}

export const sql = neon(DATABASE_URL);

export function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  try {
    const match = dataUrl.match(/^data:([^;,]+)(;charset=[^;,]+)?(;base64)?,(.*)$/i);
    if (!match) return null;
    const mime = match[1];
    const isBase64 = !!match[3];
    const tail = match[4] || '';
    const bytes = isBase64
      ? Buffer.from(tail, 'base64')
      : Buffer.from(decodeURIComponent(tail), 'utf8');
    return { mime, bytes };
  } catch (_) {
    return null;
  }
}