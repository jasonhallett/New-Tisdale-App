// /api/schedule4s/list.js
// Robust "Schedule 4s" lister that auto-detects table + columns.
// Works with common names: schedule4s, schedule_4s, vehicle_inspections, etc.
export const config = { runtime: 'nodejs' };

import { sql } from '../../db.js';

// Candidate table names in order of likelihood
const TABLE_CANDIDATES = [
  'schedule4s',
  'schedule_4s',
  'vehicle_inspections',
  'inspection_forms',
  'inspections',
  'inspection',
  'forms_schedule_4',
  'motorcoach_inspections',
];

// Column name candidates (lowercased for matching)
const COLS = {
  id: ['id', 'inspection_id', 'form_id', 'uuid'],
  created_at: [
    'created_at', 'submitted_at', 'inserted_at',
    'createdon', 'created', 'inspection_date', 'date', 'timestamp'
  ],
  unit: [
    'unit', 'unit_number', 'unit_num', 'vehicle', 'vehicle_number',
    'bus', 'bus_number', 'coach_number', 'license_plate'
  ],
  technician: [
    'technician', 'technician_name', 'tech', 'tech_name',
    'inspector', 'inspector_name', 'created_by', 'user_name'
  ],
  status: ['status', 'state', 'submitted', 'finalized', 'complete', 'completed'],
};

function pick(columns, candidates) {
  // columns: array of actual names, case preserved
  const map = Object.fromEntries(columns.map(c => [c.toLowerCase(), c]));
  for (const key of candidates) {
    if (map[key]) return map[key];
  }
  return null;
}

function quoteIdent(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}

async function getPublicTables() {
  const rows = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `;
  return rows.map(r => r.table_name);
}

async function getColumns(table) {
  const rows = await sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
  `;
  return rows.map(r => r.column_name);
}

export default async function handler(req, res) {
  try {
    // 1) Find a usable table
    const publicTables = await getPublicTables();
    const table =
      TABLE_CANDIDATES.find(t => publicTables.includes(t)) ||
      // fallback: any public table that contains both an id and a date-ish column
      (await (async () => {
        for (const t of publicTables) {
          const cols = await getColumns(t);
          const hasId = !!pick(cols, COLS.id);
          const hasDate = !!pick(cols, COLS.created_at) || cols.some(c => /date|time/i.test(c));
          if (hasId && hasDate) return t;
        }
        return null;
      })());

    if (!table) {
      res.status(500).json({
        error: 'Failed to load schedule 4s',
        details: 'No suitable table found in schema public',
        publicTables,
      });
      return;
    }

    // 2) Work out the best-fit columns for id/created_at/unit/technician/status
    const cols = await getColumns(table);
    const idCol = pick(cols, COLS.id);
    const createdCol =
      pick(cols, COLS.created_at) ||
      // last resort: any column with date/time in its name
      cols.find(c => /date|time/i.test(c));
    const unitCol = pick(cols, COLS.unit);
    const techCol = pick(cols, COLS.technician);
    const statusCol = pick(cols, COLS.status);

    if (!idCol) {
      throw new Error(`No id-like column found on ${table}`);
    }
    if (!createdCol) {
      throw new Error(`No created_at/date-like column found on ${table}`);
    }

    // 3) Build a safe SELECT list and ORDER BY
    const selectParts = [
      `${quoteIdent(idCol)} AS id`,
      `${quoteIdent(createdCol)} AS created_at`,
    ];
    if (unitCol) selectParts.push(`${quoteIdent(unitCol)} AS unit`);
    if (techCol) selectParts.push(`${quoteIdent(techCol)} AS technician`);
    if (statusCol) selectParts.push(`${quoteIdent(statusCol)} AS status`);

    const selectList = selectParts.join(', ');
    const orderExpr = `${quoteIdent(createdCol)} DESC NULLS LAST`;

    // 4) Execute dynamically (identifiers must be inlined/quoted)
    const q = `
      SELECT ${selectList}
      FROM ${quoteIdent('public')}.${quoteIdent(table)}
      ORDER BY ${orderExpr}
      LIMIT 500
    `;
    // neon serverless supports sql.unsafe for dynamic identifiers
    const rows = await sql.unsafe(q);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).end(JSON.stringify({ items: rows, table, columnMap: { idCol, createdCol, unitCol, techCol, statusCol } }));
  } catch (err) {
    console.error('schedule4s/list error:', err);
    res
      .status(500)
      .end(JSON.stringify({ error: 'Failed to load schedule 4s', details: String(err?.message || err) }));
  }
}
