// /api/schedule4s/list.js
// Returns: id, created_at (raw), created_at_display (MM/DD/YYYY HH:MI AM), unit, odometer, technician, location.
// Sorted newest first by created_at.

export const config = { runtime: 'nodejs' };

import { sql } from '../../db.js';

export default async function handler(req, res) {
  try {
    const rows = await sql`
      SELECT
        id,
        created_at,
        -- Preformat in DB to avoid browser parsing quirks; convert to America/Toronto
        to_char((created_at AT TIME ZONE 'America/Toronto'), 'MM/DD/YYYY HH12:MI AM') AS created_at_display,
        COALESCE(vehicle_name, NULLIF(payload_json->>'unitNumber', '')) AS unit,
        COALESCE(technician_name, NULLIF(payload_json->>'inspectorName','')) AS technician,
        NULLIF(
          COALESCE(
            payload_json->>'odometerKm',
            payload_json->>'odometer',
            payload_json->>'currentOdometer',
            payload_json->>'mileage'
          ),
          ''
        ) AS odometer,
        location AS location
      FROM schedule4_inspections
      ORDER BY created_at DESC NULLS LAST
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
