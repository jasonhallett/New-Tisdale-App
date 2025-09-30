import { sql } from './db.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { id } = req.query;
      if (id) {
        const worksheets = await sql`SELECT * FROM cote_daily_worksheets WHERE id=${id}`;
        if (!worksheets.length) return res.status(404).json({ error: 'Not found' });
        const ws = worksheets[0];

        const sections = await sql`
          SELECT * FROM cote_daily_sections
          WHERE worksheet_id=${id}
          ORDER BY position`;

        let rows = [];
        if (sections.length) {
          const secIds = sections.map(s => s.id);
          rows = await sql`
            SELECT * FROM cote_daily_rows
            WHERE section_id = ANY(${secIds})
            ORDER BY position`;
        }

        ws.sections = sections.map(s => ({
          ...s,
          rows: rows.filter(r => r.section_id === s.id)
        }));

        return res.status(200).json(ws);
      } else {
        const worksheets = await sql`SELECT * FROM cote_daily_worksheets ORDER BY id DESC`;
        return res.status(200).json(worksheets);
      }
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { name } = body;
      const ws = await sql`
        INSERT INTO cote_daily_worksheets (name)
        VALUES (${name})
        RETURNING *`;
      return res.status(201).json(ws[0]);
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      if (body.setDefault) {
        await sql`UPDATE cote_daily_worksheets SET is_default=false WHERE is_default=true`;
        await sql`UPDATE cote_daily_worksheets SET is_default=true WHERE id=${body.id}`;
        return res.status(200).json({ ok: true });
      }

      const { id, name, sections } = body;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (!sections) return res.status(400).json({ error: 'Missing sections' });

      await sql`UPDATE cote_daily_worksheets SET name=${name} WHERE id=${id}`;

      await sql`
        DELETE FROM cote_daily_rows
        WHERE section_id IN (SELECT id FROM cote_daily_sections WHERE worksheet_id=${id})`;
      await sql`DELETE FROM cote_daily_sections WHERE worksheet_id=${id}`;

      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const newSec = await sql`
          INSERT INTO cote_daily_sections (worksheet_id, section_name, position)
          VALUES (${id}, ${s.section_name}, ${i})
          RETURNING id`;
        const newSecId = newSec[0].id;

        for (let j = 0; j < s.rows.length; j++) {
          const r = s.rows[j];
          await sql`
            INSERT INTO cote_daily_rows (
              section_id,
              bus_number_default,
              pickup_default,
              dropoff_default,
              pickup_time_default,
              ds_in_am_default,
              ns_out_am_default,
              ds_out_pm_default,
              ns_in_pm_default,
              position
            )
            VALUES (
              ${newSecId},
              ${r.bus_number_default},
              ${r.pickup_default},
              ${r.dropoff_default},
              ${r.pickup_time_default},
              ${r.ds_in_am_default},
              ${r.ns_out_am_default},
              ${r.ds_out_pm_default},
              ${r.ns_in_pm_default},
              ${j}
            )`;
        }
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Worksheets API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
