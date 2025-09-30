import { sql } from '../../db.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { rows } = await sql`SELECT * FROM drivers ORDER BY id`;
      return res.status(200).json(rows);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { first_name, last_name } = body;
      const { rows } = await sql`
        INSERT INTO drivers (first_name, last_name)
        VALUES (${first_name}, ${last_name}) RETURNING *`;
      return res.status(201).json(rows[0]);
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { id, first_name, last_name } = body;
      const { rows } = await sql`
        UPDATE drivers
        SET first_name=${first_name}, last_name=${last_name}
        WHERE id=${id} RETURNING *`;
      return res.status(200).json(rows[0]);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Drivers API error:', err);
    return res.status(500).json({ error: 'Server error', detail: err.message });
  }
}
