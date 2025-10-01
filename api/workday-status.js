// /api/workday-status.js
import { Pool } from 'pg';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl:{ rejectUnauthorized:false } });
function ok(res, body, status=200){ res.setHeader('Content-Type','application/json'); res.status(status).end(JSON.stringify(body)); }
function bad(res, msg, status=400){ res.setHeader('Content-Type','application/json'); res.status(status).end(JSON.stringify({ error: msg })); }
async function q(sql, params){ const c = await pool.connect(); try{ return await c.query(sql, params);} finally{ c.release(); } }

export default async function handler(req, res){
  try{
    if (req.method === 'GET'){
      const r = await q(`select id, name, is_active from workday_status where is_active=true order by sort_order, name`, []);
      return ok(res, r.rows);
    }
    res.setHeader('Allow','GET'); return bad(res, 'Method Not Allowed', 405);
  }catch(err){ return bad(res, err.message || 'Server error', 500); }
}
