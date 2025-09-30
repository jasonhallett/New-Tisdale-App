// /api/schedule4s/get.js — return a single Schedule 4 by id
export const config = { runtime: 'nodejs' };

import { sql } from '../db.js';

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const id = url.searchParams.get('id');
    if (!id) {
      res.status(400).end(JSON.stringify({ error: 'id is required' }));
      return;
    }
    const rows = await sql`
      SELECT id, performed_at, created_at, expiry_date, vehicle_name, technician_name, payload_json
      FROM schedule4_inspections
      WHERE id = ${id}
      LIMIT 1
    `;
    if (!rows || rows.length === 0) {
      res.status(404).end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const item = rows[0];
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).end(JSON.stringify({ item }));
  } catch (err) {
    res.status(500).end(JSON.stringify({ error: 'Failed to load schedule 4', details: String(err?.message || err) }));
  }
}
