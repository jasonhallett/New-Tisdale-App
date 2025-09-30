import { sql } from './db.js';

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { id } = req.query;

      if (id) {
        const ws = (await sql`SELECT * FROM cote_daily_worksheets WHERE id=${id}`)[0];
        if (!ws) return res.status(404).json({ error: 'Not found' });

        const sections = await sql`
          SELECT id, worksheet_id, section_name, position
          FROM cote_daily_sections
          WHERE worksheet_id=${id}
          ORDER BY position`;

        let rows = [];
        if (sections.length) {
          const secIds = sections.map(s => s.id);
          rows = await sql`
            SELECT id, section_id, bus_number_default, pickup_default, dropoff_default,
                   pickup_time_default, ds_in_am_default, ns_out_am_default,
                   ds_out_pm_default, ns_in_pm_default, position
            FROM cote_daily_rows
            WHERE section_id = ANY(${secIds})
            ORDER BY position`;
        }

        ws.sections = sections.map(s => ({
          ...s,
          rows: rows.filter(r => r.section_id === s.id)
        }));

        return res.status(200).json(ws);
      }

      const worksheets = await sql`
        SELECT id, name, is_default, created_at
        FROM cote_daily_worksheets
        ORDER BY id DESC`;
      return res.status(200).json(worksheets);
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { name } = body;
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

      const ws = await sql`
        INSERT INTO cote_daily_worksheets (name)
        VALUES (${name.trim()})
        RETURNING id, name, is_default, created_at`;
      return res.status(201).json(ws[0]);
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      // Set default only
      if (body.setDefault) {
        await sql`UPDATE cote_daily_worksheets SET is_default=false WHERE is_default=true`;
        await sql`UPDATE cote_daily_worksheets SET is_default=true WHERE id=${body.id}`;
        return res.status(200).json({ ok: true });
      }

      // Save-All
      const { id, name, sections } = body;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (!Array.isArray(sections)) return res.status(400).json({ error: 'Missing sections[]' });

      await sql`UPDATE cote_daily_worksheets SET name=${name || 'Untitled'} WHERE id=${id}`;

      // wipe old
      await sql`
        DELETE FROM cote_daily_rows
        WHERE section_id IN (SELECT id FROM cote_daily_sections WHERE worksheet_id=${id})`;
      await sql`DELETE FROM cote_daily_sections WHERE worksheet_id=${id}`;

      // reinsert sections + rows with positions
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i];
        const section_name = s.section_name || `Section ${i+1}`;
        const newSec = await sql`
          INSERT INTO cote_daily_sections (worksheet_id, section_name, position)
          VALUES (${id}, ${section_name}, ${i})
          RETURNING id`;
        const newSecId = newSec[0].id;

        const rows = Array.isArray(s.rows) ? s.rows : [];
        for (let j = 0; j < rows.length; j++) {
          const r = rows[j];
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
              ${r.bus_number_default || null},
              ${r.pickup_default || null},
              ${r.dropoff_default || null},
              ${r.pickup_time_default || null},
              ${r.ds_in_am_default ?? 0},
              ${r.ns_out_am_default ?? 0},
              ${r.ds_out_pm_default ?? 0},
              ${r.ns_in_pm_default ?? 0},
              ${j}
            )`;
        }
      }

      // Return the rebuilt worksheet so the UI refreshes with server truth
      const ws = (await sql`SELECT * FROM cote_daily_worksheets WHERE id=${id}`)[0];
      const newSections = await sql`
        SELECT id, worksheet_id, section_name, position
        FROM cote_daily_sections
        WHERE worksheet_id=${id}
        ORDER BY position`;
      const secIds = newSections.map(s => s.id);
      const newRows = secIds.length
        ? await sql`
          SELECT *
          FROM cote_daily_rows
          WHERE section_id = ANY(${secIds})
          ORDER BY position`
        : [];
      ws.sections = newSections.map(s => ({
        ...s,
        rows: newRows.filter(r => r.section_id === s.id)
      }));
      return res.status(200).json(ws);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('Worksheets API error:', err);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
}
