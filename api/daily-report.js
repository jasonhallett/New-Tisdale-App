// /api/daily-report.js
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false } });
function ok(res, body, status=200){ res.setHeader('Content-Type','application/json'); res.status(status).end(JSON.stringify(body)); }
function bad(res, msg, status=400){ res.setHeader('Content-Type','application/json'); res.status(status).end(JSON.stringify({ error: msg })); }
async function q(sql, params){ const c = await pool.connect(); try{ return await c.query(sql, params);} finally{ c.release(); } }

export default async function handler(req, res){
  try{
    if (req.method === 'GET'){
      const { id, date } = req.query || {};
      if (id){
        const r = await q(`select id, report_date, worksheet_id, header, drivers, sections, submitted, created_at, updated_at from daily_reports where id=$1`, [id]);
        if (!r.rowCount) return bad(res, 'Not found', 404);
        return ok(res, r.rows[0]);
      }
      if (date){
        const r = await q(`select id, report_date, worksheet_id from daily_reports where report_date=$1`, [date]);
        return ok(res, r.rows);
      }
      const r = await q(`select id, report_date, worksheet_id, submitted, updated_at from daily_reports order by report_date desc limit 30`, []);
      return ok(res, r.rows);
    }

    if (req.method === 'POST' || req.method === 'PUT'){
      const { id, report_date, worksheet_id, header, drivers, sections, submitted } = req.body || {};
      if (!report_date) return bad(res, 'Missing report_date');
      if (!worksheet_id) return bad(res, 'Missing worksheet_id');

      const driverBusSet = new Set();
      (drivers || []).forEach(d => (d.buses||[]).forEach(b => driverBusSet.add(String(b))));
      const badCells = [];
      (sections || []).forEach((s, si) => (s.entries||[]).forEach((r, ri) => {
        const buses = (r.buses || []).map(String);
        const invalid = buses.filter(b => !driverBusSet.has(b));
        if (invalid.length) badCells.push({ si, ri, invalid });
      }));
      if (badCells.length) return bad(res, `Invalid buses in rows: ${JSON.stringify(badCells)}`);

      if (req.method === 'POST'){
        const r = await q(`
          insert into daily_reports (report_date, worksheet_id, header, drivers, sections, submitted)
          values ($1,$2,$3,$4,$5,$6)
          returning id
        `,[report_date, worksheet_id, header||{}, drivers||[], sections||[], !!submitted]);
        return ok(res, { id: r.rows[0].id }, 201);
      } else {
        if (!id) return bad(res, 'Missing id for update');
        await q(`
          update daily_reports set
            report_date=$1, worksheet_id=$2, header=$3, drivers=$4, sections=$5, submitted=$6, updated_at=now()
          where id=$7
        `,[report_date, worksheet_id, header||{}, drivers||[], sections||[], !!submitted, id]);
        return ok(res, { id });
      }
    }

    res.setHeader('Allow','GET,POST,PUT'); return bad(res, 'Method Not Allowed', 405);
  }catch(err){ return bad(res, err.message || 'Server error', 500); }
}
