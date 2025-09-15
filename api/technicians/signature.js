// /api/technicians/signature.js — Update saved signature for current technician
export const config = { runtime: 'nodejs' };

import { sql, parseDataUrl } from '../../db.js';
import { readRawBody } from '../../utils/body.js';
import { getAuthIdentity } from '../../auth.js';

export default async function handler(req, res) {
  if (req.method !== 'PUT') {
    res.setHeader('Allow', 'PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = getAuthIdentity(req);
  if (!auth?.userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = '';
  try { body = await readRawBody(req); } catch { return res.status(400).json({ error: 'Bad request' }); }
  let json; try { json = JSON.parse(body); } catch { json = {}; }

  const dataUrl = json?.signatureDataUrl || json?.signature || null;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed?.buffer || !parsed?.mime) {
    return res.status(400).json({ error: 'Invalid or missing signatureDataUrl' });
  }

  try {
    await sql`
      UPDATE technicians
         SET signature_image = ${parsed.buffer},
             signature_image_mime = ${parsed.mime},
             signature_last_updated = now()
       WHERE app_user_id = ${auth.userId}
    `;
    return res.status(204).end();
  } catch (e) {
    console.error('PUT /api/technicians/signature failed', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

);
      req.on('end', () => resolve(data));
      req.on('error', reject);
    } catch (err) { reject(err); }
  });
}
