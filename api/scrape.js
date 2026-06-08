import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    execSync('node scraper/engine.js', {
      cwd: process.cwd(),
      timeout: 110000,
      stdio: 'pipe'
    });

    const leadsPath = path.join(process.cwd(), 'data', 'leads.json');
    const statePath = path.join(process.cwd(), 'data', 'state.json');
    if (!fs.existsSync(leadsPath)) {
      return res.status(500).json({ success: false, error: 'Engine ran but produced no output' });
    }
    const leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));
    const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : {};
    res.json({ success: true, count: leads.length, leads, state });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
