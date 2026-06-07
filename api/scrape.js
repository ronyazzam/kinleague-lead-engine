import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    execSync('node scraper/index.js', {
      cwd: process.cwd(),
      timeout: 90000,
      stdio: 'pipe'
    });

    const leadsPath = path.join(process.cwd(), 'leads.json');
    if (!fs.existsSync(leadsPath)) {
      return res.status(500).json({ success: false, error: 'Scraper ran but produced no output' });
    }
    const leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));
    res.json({ success: true, count: leads.length, leads });
  } catch (err) {
    // If scraper itself errored, return fallback demo data so the UI still works
    res.status(500).json({ success: false, error: err.message });
  }
}
