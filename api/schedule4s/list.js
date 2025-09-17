// /api/schedule4s/list.js
// List Schedule 4s and return fields the grid expects, newest first by created/inspected date.

export const config = { runtime: 'nodejs' };

import { sql } from '../../db.js';

export default async function handler(req, res) {
  try {
    const rows = await sql`
      SELECT
        id,
        COALESCE(performed_at, created_at) AS created_at,
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
        NULLIF(
          COALESCE(
            payload_json->>'inspectionLocation',
            payload_json->>'location',
            payload_json->>'address',
            payload_json->>'inspectionAddress'
          ),
          ''
        ) AS location
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
