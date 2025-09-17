// /api/schedule4s/list.js
// Returns: id, created_at (Date Inspected), unit, odometer, technician, location (address).
// Newest first.

export const config = { runtime: 'nodejs' };

import { sql } from '../../db.js';

export default async function handler(req, res) {
  try {
    const rows = await sql`
      SELECT
        id,
        COALESCE(performed_at, created_at) AS created_at,
        /* Unit # */
        COALESCE(vehicle_name, NULLIF(payload_json->>'unitNumber', '')) AS unit,
        /* Technician Name */
        COALESCE(technician_name, NULLIF(payload_json->>'inspectorName','')) AS technician,
        /* Odometer */
        NULLIF(
          COALESCE(
            payload_json->>'odometerKm',
            payload_json->>'odometer',
            payload_json->>'currentOdometer',
            payload_json->>'mileage'
          ),
          ''
        ) AS odometer,
        /* Inspection Location / Address: try normalized columns, then JSON fallbacks */
        COALESCE(
          NULLIF(TRIM(inspection_address), ''),
          NULLIF(TRIM(inspection_location), ''),
          NULLIF(TRIM(location_address), ''),
          NULLIF(TRIM(location), ''),
          NULLIF(TRIM(address), ''),
          NULLIF(TRIM(payload_json->>'inspectionLocationAddress'), ''),
          NULLIF(TRIM(payload_json->>'inspectionLocation'), ''),
          NULLIF(TRIM(payload_json->>'locationAddress'), ''),
          NULLIF(TRIM(payload_json->>'location'), ''),
          NULLIF(TRIM(payload_json->>'address'), '')
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
