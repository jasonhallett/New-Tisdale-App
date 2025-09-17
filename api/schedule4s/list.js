// /api/schedule4s/list.js
// Schedule 4s lister without sql.unsafe — tries a few common table/column layouts.
export const config = { runtime: 'nodejs' };

import { sql } from '../../db.js';

export default async function handler(req, res) {
  // Each entry is a function that issues a concrete query (no dynamic identifiers).
  // If it succeeds, we normalize the output fields.
  const tryQueries = [
    // schedule4s
    async () => {
      const rows = await sql`
        SELECT id, created_at,
               unit_number      AS unit,
               technician_name  AS technician,
               status
        FROM schedule4s
        ORDER BY created_at DESC
        LIMIT 500
      `;
      return rows;
    },
    async () => {
      const rows = await sql`
        SELECT id, inspection_date AS created_at,
               unit_number        AS unit,
               technician_name    AS technician,
               status
        FROM schedule4s
        ORDER BY inspection_date DESC
        LIMIT 500
      `;
      return rows;
    },

    // schedule_4s
    async () => {
      const rows = await sql`
        SELECT id, created_at,
               unit_number      AS unit,
               technician_name  AS technician,
               status
        FROM schedule_4s
        ORDER BY created_at DESC
        LIMIT 500
      `;
      return rows;
    },
    async () => {
      const rows = await sql`
        SELECT id, inspection_date AS created_at,
               unit_number        AS unit,
               technician_name    AS technician,
               status
        FROM schedule_4s
        ORDER BY inspection_date DESC
        LIMIT 500
      `;
      return rows;
    },

    // vehicle_inspections
    async () => {
      const rows = await sql`
        SELECT id, created_at,
               unit_number      AS unit,
               technician_name  AS technician,
               status
        FROM vehicle_inspections
        ORDER BY created_at DESC
        LIMIT 500
      `;
      return rows;
    },
    async () => {
      const rows = await sql`
        SELECT id, created_at
        FROM vehicle_inspections
        ORDER BY created_at DESC
        LIMIT 500
      `;
      return rows;
    },

    // motorcoach_inspections
    async () => {
      const rows = await sql`
        SELECT id, created_at,
               unit         AS unit,
               technician   AS technician,
               status
        FROM motorcoach_inspections
        ORDER BY created_at DESC
        LIMIT 500
      `;
      return rows;
    },

    // inspection_forms
    async () => {
      const rows = await sql`
        SELECT id, created_at,
               unit         AS unit,
               technician   AS technician,
               status
        FROM inspection_forms
        ORDER BY created_at DESC
        LIMIT 500
      `;
      return rows;
    },

    // inspections (if you actually have this)
    async () => {
      const rows = await sql`
        SELECT id, created_at
        FROM inspections
        ORDER BY created_at DESC
        LIMIT 500
      `;
      return rows;
    },
  ];

  const tried = [];
  try {
    for (const q of tryQueries) {
      try {
        const rows = await q();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.status(200).end(JSON.stringify({ items: rows }));
        return;
      } catch (err) {
        // Record which attempt failed (by function index) for debugging
        tried.push(String(err?.message || err));
        continue;
      }
    }

    // If we get here, none of the known shapes worked
    res.status(500).end(
      JSON.stringify({
        error: 'Failed to load schedule 4s',
        details:
          'No recognized table/column layout found. Tell me the exact table and column names and I will lock this down.',
        attempts: tried.slice(0, 5), // trim noise
      })
    );
  } catch (err) {
    res
      .status(500)
      .end(JSON.stringify({ error: 'Failed to load schedule 4s', details: String(err?.message || err) }));
  }
}
