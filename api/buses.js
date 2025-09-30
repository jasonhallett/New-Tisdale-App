import { sql } from '../../db.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { rows } = await sql`SELECT * FROM buses ORDER BY id`;
      return res.json(rows);
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { unit_number } = body;
      const { rows } = await sql`INSERT INTO buses (unit_number) VALUES (${unit_number}) RETURNING *`;
      return res.json(rows[0]);
    }
    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { id, unit_number } = body;
      const { rows } = await sql`UPDATE buses SET unit_number=${unit_number} WHERE id=${id} RETURNING *`;
      return res.json(rows[0]);
    }
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}