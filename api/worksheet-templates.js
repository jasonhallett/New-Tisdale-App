// /api/worksheet-templates.js
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL);

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { id } = req.query;
      if (id) {
        // Get template with sections + columns
        const template = await sql`SELECT * FROM cote_worksheet_templates WHERE id=${id}`;
        if (!template.length) return res.status(404).json({ error: 'Not found' });
        const sections = await sql`SELECT * FROM cote_worksheet_sections WHERE template_id=${id} ORDER BY position`;
        for (const sec of sections) {
          const cols = await sql`SELECT * FROM cote_worksheet_columns WHERE section_id=${sec.id} ORDER BY position`;
          sec.columns = cols;
        }
        return res.json({ ...template[0], sections });
      } else {
        const templates = await sql`SELECT * FROM cote_worksheet_templates ORDER BY created_at DESC`;
        return res.json(templates);
      }
    }

    if (req.method === 'POST') {
      const { name } = req.body;
      const { rows } = await sql`
        INSERT INTO cote_worksheet_templates (name, version)
        VALUES (${name}, 1) RETURNING *`;
      return res.json(rows[0]);
    }

    if (req.method === 'PUT') {
      const { id, name, sections, version } = req.body;
      // Bump version if making changes
      const newVersion = version + 1;
      const { rows } = await sql`
        INSERT INTO cote_worksheet_templates (name, version)
        VALUES (${name}, ${newVersion})
        RETURNING *`;
      const newTemplate = rows[0];
      // Clone sections/columns
      for (const [i, sec] of sections.entries()) {
        const { rows: secRows } = await sql`
          INSERT INTO cote_worksheet_sections (template_id, title, position)
          VALUES (${newTemplate.id}, ${sec.title}, ${i})
          RETURNING *`;
        const newSec = secRows[0];
        for (const [j, col] of (sec.columns || []).entries()) {
          await sql`
            INSERT INTO cote_worksheet_columns (section_id, label, key, data_type, position)
            VALUES (${newSec.id}, ${col.label}, ${col.key}, ${col.data_type}, ${j})`;
        }
      }
      return res.json(newTemplate);
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
}
