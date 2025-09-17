// /api/schedule4s/list.js
// Returns the latest Schedule 4s (inspections) with minimal, safe fields.
export const config = { runtime: 'nodejs' };

import { sql } from '../../db.js';

export default async function handler(req, res) {
  try {
    // NOTE: UI is already guarded by auth-guard.js; if you want server-side
    // checks later, we can add them once we confirm the auth helper export names.
    const rows = await sql`
      SELECT id, created_at
      FROM inspections
      ORDER BY created_at DESC
      LIMIT 500
    `;

    // Shape matches what the grid expects: [{ id, created_at }, ...]
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).end(JSON.stringify({ items: rows }));
  } catch (err) {
    console.error('schedule4s/list error:', err);
    res
      .status(500)
      .end(JSON.stringify({ error: 'Failed to load schedule 4s', details: String(err?.message || err) }));
  }
}
