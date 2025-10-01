// /api/worksheets.js
// Vercel/Node API route for Worksheet CRUD (Neon Postgres).
// Adds support for `note_default` in row payloads.
//
// Endpoints used by the front-end:
//   GET  /api/worksheets                 -> list worksheets [{id,name,is_default}]
//   GET  /api/worksheets?id={id}         -> get worksheet with sections+rows
//   POST /api/worksheets { name }        -> create worksheet
//   PUT  /api/worksheets { id, setDefault }        -> set default
//   PUT  /api/worksheets { id, sections:[...] }    -> replace sections+rows for worksheet
//
// Requires: process.env.DATABASE_URL (Neon connection string)

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function ok(res, body, status=200){
  res.setHeader('Content-Type','application/json');
  res.status(status).end(JSON.stringify(body));
}
function bad(res, msg, status=400){
  res.setHeader('Content-Type','application/json');
  res.status(status).end(JSON.stringify({ error: msg }));
}
async function q(sql, params){
  const client = await pool.connect();
  try {
    const r = await client.query(sql, params);
    return r;
  } finally {
    client.release();
  }
}

export default async function handler(req, res){
  try {
    if (req.method === 'GET') {
      const id = req.query.id;
      if (!id) {
        const r = await q(`
          select id, name, coalesce(is_default,false) as is_default
          from cote_daily_worksheets
          order by coalesce(is_default,false) desc, name asc
        `, []);
        return ok(res, r.rows);
      } else {
        const wsr = await q(`
          select id, name, coalesce(is_default,false) as is_default
          from cote_daily_worksheets
          where id = $1
        `,[id]);
        if (!wsr.rowCount) return bad(res, 'Worksheet not found', 404);
        const worksheet = wsr.rows[0];

        const sec = await q(`
          select id, section_name, position
          from cote_daily_sections
          where worksheet_id = $1
          order by position asc, id asc
        `,[id]);

        const sections = [];
        for (const s of sec.rows){
          const rows = await q(`
            select id, bus_number_default, pickup_default, dropoff_default,
                   pickup_time_default, note_default,
                   ds_in_am_default, ns_out_am_default, ds_out_pm_default, ns_in_pm_default,
                   position
            from cote_daily_rows
            where section_id = $1
            order by position asc, id asc
          `,[s.id]);
          sections.push({
            id: s.id,
            section_name: s.section_name,
            position: s.position,
            rows: rows.rows
          });
        }

        return ok(res, { id: worksheet.id, name: worksheet.name, is_default: worksheet.is_default, sections });
      }
    }

    if (req.method === 'POST') {
      const { name } = req.body || {};
      if (!name || !String(name).trim()) return bad(res, 'Missing name');
      const r = await q(`
        insert into cote_daily_worksheets (name, is_default)
        values ($1, false)
        returning id, name, is_default
      `,[name.trim()]);
      return ok(res, r.rows[0], 201);
    }

    if (req.method === 'PUT') {
      const { id, setDefault, sections } = req.body || {};
      if (!id) return bad(res, 'Missing id');

      if (setDefault) {
        await q(`update cote_daily_worksheets set is_default=false`, []);
        await q(`update cote_daily_worksheets set is_default=true where id=$1`, [id]);
        return ok(res, { id, setDefault: true });
      }

      // Replace sections+rows atomically for this worksheet
      if (!Array.isArray(sections)) return bad(res, 'Missing sections array');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // delete rows/sections for only this worksheet
        await client.query(`
          delete from cote_daily_rows
          where section_id in (select id from cote_daily_sections where worksheet_id = $1)
        `,[id]);
        await client.query(`delete from cote_daily_sections where worksheet_id = $1`, [id]);

        // recreate sections and rows
        for (const [idx, s] of sections.entries()) {
          const rSec = await client.query(`
            insert into cote_daily_sections (worksheet_id, section_name, position)
            values ($1, $2, $3)
            returning id
          `,[id, s.section_name || '', Number.isFinite(s.position)? s.position : idx]);
          const sectionId = rSec.rows[0].id;

          for (const [ridx, r] of (s.rows || []).entries()) {
            await client.query(`
              insert into cote_daily_rows (
                section_id,
                bus_number_default, pickup_default, dropoff_default,
                pickup_time_default, note_default,
                ds_in_am_default, ns_out_am_default, ds_out_pm_default, ns_in_pm_default,
                position
              ) values (
                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11
              )
            `,[
              sectionId,
              r.bus_number_default ?? '',
              r.pickup_default ?? '',
              r.dropoff_default ?? '',
              r.pickup_time_default ?? null,
              r.note_default ?? null,
              parseInt(r.ds_in_am_default ?? 0,10),
              parseInt(r.ns_out_am_default ?? 0,10),
              parseInt(r.ds_out_pm_default ?? 0,10),
              parseInt(r.ns_in_pm_default ?? 0,10),
              Number.isFinite(r.position)? r.position : ridx
            ]);
          }
        }

        await client.query('COMMIT');

        // return fresh
        const wsr = await client.query(`
          select id, name, coalesce(is_default,false) as is_default
          from cote_daily_worksheets where id=$1
        `,[id]);
        const ws = wsr.rows[0];
        const sec = await client.query(`
          select id, section_name, position from cote_daily_sections where worksheet_id=$1 order by position asc, id asc
        `,[id]);
        const sectionsOut = [];
        for (const s of sec.rows) {
          const rr = await client.query(`
            select id, bus_number_default, pickup_default, dropoff_default,
                   pickup_time_default, note_default,
                   ds_in_am_default, ns_out_am_default, ds_out_pm_default, ns_in_pm_default,
                   position
            from cote_daily_rows where section_id=$1 order by position asc, id asc
          `,[s.id]);
          sectionsOut.push({ id: s.id, section_name: s.section_name, position: s.position, rows: rr.rows });
        }
        return ok(res, { id: ws.id, name: ws.name, is_default: ws.is_default, sections: sectionsOut });
      } catch (e) {
        try { await pool.query('ROLLBACK'); } catch {}
        return bad(res, e.message || 'Update failed', 500);
      } finally {
        client.release();
      }
    }

    res.setHeader('Allow', 'GET,POST,PUT');
    return bad(res, 'Method Not Allowed', 405);
  } catch (err) {
    return bad(res, err.message || 'Server error', 500);
  }
}
