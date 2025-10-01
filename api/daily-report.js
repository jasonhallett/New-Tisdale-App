// /api/daily-report.js
// Robust handler for daily reports:
// - Accepts header/drivers/sections as objects OR JSON strings
// - Normalizes to objects for validation
// - Serializes JSON payloads for SQL casts (::jsonb)
// - Works for GET (list/read), POST (create), PUT (update)

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

function ok(res, body, status = 200) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(body));
}
function bad(res, msg, status = 400) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify({ error: msg }));
}
async function q(sql, params) {
  const c = await pool.connect();
  try { return await c.query(sql, params); }
  finally { c.release(); }
}

function asObj(maybeJson, fallback) {
  if (maybeJson == null) return fallback;
  if (typeof maybeJson === 'string') {
    try { const o = JSON.parse(maybeJson); return o == null ? fallback : o; }
    catch { return fallback; }
  }
  if (typeof maybeJson === 'object') return maybeJson;
  return fallback;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { id, date } = req.query || {};

      if (id) {
        const r = await q(
          `select id, report_date, worksheet_id, header, drivers, sections, submitted, created_at, updated_at
           from daily_reports where id = $1`,
          [id]
        );
        if (!r.rowCount) return bad(res, 'Not found', 404);

        const row = r.rows[0];
        row.header   = asObj(row.header, {});
        row.drivers  = asObj(row.drivers, []);
        row.sections = asObj(row.sections, []);
        return ok(res, row);
      }

      if (date) {
        const r = await q(
          `select id, report_date, worksheet_id
           from daily_reports
           where report_date = $1`,
          [date]
        );
        return ok(res, r.rows);
      }

      const r = await q(
        `select id, report_date, worksheet_id, submitted, updated_at
         from daily_reports
         order by report_date desc
         limit 50`,
        []
      );
      return ok(res, r.rows);
    }

    if (req.method !== 'POST' && req.method !== 'PUT') {
      res.setHeader('Allow', 'GET,POST,PUT');
      return bad(res, 'Method Not Allowed', 405);
    }

    // --- Normalize inputs from body ---
    const {
      id,
      report_date,
      worksheet_id,
      submitted
    } = req.body || {};

    let header   = asObj(req.body?.header, {});
    let drivers  = asObj(req.body?.drivers, []);
    let sections = asObj(req.body?.sections, []);

    if (!report_date)  return bad(res, 'Missing report_date');
    if (!worksheet_id) return bad(res, 'Missing worksheet_id');

    // --- Validation: each row's bus_numbers ⊆ buses selected in header ---
    const headerBusSet = new Set();
    (drivers || []).forEach(d => (d?.buses || []).forEach(b => headerBusSet.add(String(b))));

    const invalidCells = [];
    (sections || []).forEach((s, si) => (s?.entries || []).forEach((r, ri) => {
      const buses = (Array.isArray(r?.bus_numbers) ? r.bus_numbers : (r?.buses || [])).map(String);
      const badOnes = buses.filter(b => !headerBusSet.has(b));
      if (badOnes.length) invalidCells.push({ si, ri, invalid: badOnes });
    }));
    if (invalidCells.length) {
      return bad(res, `Invalid buses in rows: ${JSON.stringify(invalidCells)}`);
    }

    // --- Prepare values for SQL (::jsonb expects TEXT of valid JSON) ---
    const headerJson   = JSON.stringify(header ?? {});
    const driversJson  = JSON.stringify(drivers ?? []);
    const sectionsJson = JSON.stringify(sections ?? []);
    const isSubmitted  = !!submitted;

    if (req.method === 'POST') {
      const r = await q(
        `insert into daily_reports (report_date, worksheet_id, header, drivers, sections, submitted)
         values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6)
         returning id`,
        [report_date, worksheet_id, headerJson, driversJson, sectionsJson, isSubmitted]
      );
      return ok(res, { id: r.rows[0].id }, 201);
    }

    // PUT (update)
    if (!id) return bad(res, 'Missing id for update');
    await q(
      `update daily_reports set
         report_date = $1,
         worksheet_id = $2,
         header = $3::jsonb,
         drivers = $4::jsonb,
         sections = $5::jsonb,
         submitted = $6,
         updated_at = now()
       where id = $7`,
      [report_date, worksheet_id, headerJson, driversJson, sectionsJson, isSubmitted, id]
    );
    return ok(res, { id });
  } catch (err) {
    return bad(res, err?.message || 'Server error', 500);
  }
}
