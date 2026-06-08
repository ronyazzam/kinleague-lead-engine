import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const f = path.join(process.cwd(), 'data', 'state.json');
    res.json(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f)) : { lastRun: null, totalLeads: 0 });
  } catch { res.json({ lastRun: null, totalLeads: 0 }); }
}
