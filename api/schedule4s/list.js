// /api/schedule4s/list.js
// List Schedule 4s from the real table/columns in your DB.
// Uses schedule4_inspections and returns fields the grid expects.

export const config = { runtime: 'nodejs' };

import { sql } from '../../db.js';

export default async function handler(req, res) {
  try {
    const rows = await sql`
      SELECT
        id,
        -- Prefer performed_at if present; otherwise created_at
        COALESCE(performed_at, created_at)                AS created_at,
        -- Try vehicle_name first; fall back to payload_json->>'unitNumber'
        COALESCE(vehicle_name, NULLIF(payload_json->>'unitNumber', '')) AS unit,
        -- Prefer technician_name; fall back to payload_json->>'inspectorName'
        COALESCE(technician_name, NULLIF(payload_json->>'inspectorName','')) AS technician,
        -- Simple derived status for display purposes
        CASE
          WHEN expiry_date IS NOT NULL AND expiry_date::date < NOW()::date THEN 'Expired'
          ELSE 'Completed'
        END AS status
      FROM schedule4_inspections
      ORDER BY 2 DESC NULLS LAST
      LIMIT 500
    `;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).end(JSON.stringify({ items: rows }));
  } catch (err) {
    console.error('schedule4s/list error:', err);
    res
      .status(500)
      .end(JSON.stringify({ error: 'Failed to load schedule 4s', details: err?.message || String(err) }));
  }
}
