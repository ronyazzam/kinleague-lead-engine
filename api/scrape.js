import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // Directly import the engine — no child process, so Vercel bundles it correctly
    const { runScrapeAndPush } = require('../scraper/engine.js');
    const state = await runScrapeAndPush();

    const leadsPath = path.join(process.cwd(), 'data', 'leads.json');
    const leads = fs.existsSync(leadsPath) ? JSON.parse(fs.readFileSync(leadsPath)) : [];

    res.json({ success: true, count: leads.length, state, leads });
  } catch (err) {
    console.error('Scraper error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}
