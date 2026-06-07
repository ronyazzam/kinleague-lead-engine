import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const leadsPath = path.join(process.cwd(), 'leads.json');
    if (!fs.existsSync(leadsPath)) return res.json({ leads: [] });
    const leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));
    res.json({ leads });
  } catch {
    res.json({ leads: [] });
  }
}
