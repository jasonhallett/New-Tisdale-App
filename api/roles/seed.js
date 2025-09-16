// /api/roles/seed.js — POST idempotent seed
export const config = { runtime: 'nodejs' };
import { sql } from '../../db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow','POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const defaults = [
      ['ADMIN', 'Full administrative access to all features.'],
      ['TECHNICIAN', 'Performs inspections; requires STO / Trade Codes.'],
      ['FINANCE', 'Billing, payroll, and financial reporting features.'],
      ['SALES', 'Quotes, opportunities, and CRM features.'],
      ['OPERATIONS', 'Dispatch, scheduling, and daily operations.'],
      ['HR', 'Employee onboarding, records, and compliance.'],
    ];
    await sql`
      INSERT INTO roles (role_name, description)
      SELECT x.role_name, x.description
      FROM (SELECT * FROM unnest(${defaults}::text[][])
            AS t(role_name, description)) AS x
      ON CONFLICT (role_name) DO UPDATE SET description = EXCLUDED.description
    `;
    return res.status(200).json({ ok: true, inserted: defaults.map(d => d[0]) });
  } catch (e) {
    console.error('POST /api/roles/seed failed', e);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
