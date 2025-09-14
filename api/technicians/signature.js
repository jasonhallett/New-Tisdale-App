// /api/technicians/me/signature.js — Auth-ready skeleton to update saved signature
export const config = { runtime: 'nodejs' };

import { sql, parseDataUrl } from '../../db.js';

/**
 * Placeholder auth extractor. Once login is implemented,
 * replace this to read from your session/cookie/JWT.
 * For now, this returns null to enforce 401.
 */
function getAuthIdentity(req) {
  return null; // TODO: integrate real auth
}

export default async function handler(req, res) {
  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = getAuthIdentity(req);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized', details: 'Login required' });
  }

  let body = '';
  try {
    body = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Failed to read body' });
  }

  let json;
  try { json = JSON.parse(body); } catch { json = {}; }

  const dataUrl = json?.signatureDataUrl || json?.signature || null;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed?.bytes || !parsed?.mime) {
    return res.status(400).json({ error: 'Invalid or missing signatureDataUrl' });
  }

  try {
    await sql`
      UPDATE technicians
      SET signature_image = ${parsed.bytes},
          signature_image_mime = ${parsed.mime},
          signature_last_updated = now()
      WHERE app_user_id = ${auth.userId}
    `;
    return res.status(204).end();
  } catch (e) {
    console.error('PUT /api/technicians/me/signature failed', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { data += chunk; if (data.length > 5_000_000) req.destroy(); });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    } catch (err) { reject(err); }
  });
}
