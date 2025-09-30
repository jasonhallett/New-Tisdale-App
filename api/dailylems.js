// /api/dailylems.js
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT id, date, buses_driver_only, buses_driver_bus
        FROM daily_lems
        ORDER BY date DESC
        LIMIT 50
      `;
      res.status(200).json(rows);
    } else {
      res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}
