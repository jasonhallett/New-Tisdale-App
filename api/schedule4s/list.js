export const config = { runtime: 'nodejs' };
import { sql } from '../../db.js';
import { getSessionFromRequest } from '../../auth.js';

export default async function handler(req, res){
  try{
    try { await getSessionFromRequest?.(req); } catch {}
    const rows = await sql`SELECT id, created_at FROM inspections ORDER BY created_at DESC LIMIT 500`;
    const items = rows.map(r => ({ id: r.id, created_at: r.created_at }));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).end(JSON.stringify({ items }));
  }catch(err){
    res.status(500).end(JSON.stringify({ error: 'Failed to load schedule 4s', details: String(err?.message || err) }));
  }
}
