import fs from 'fs';
import path from 'path';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const dataFile = path.join(process.cwd(), 'data', 'leads.json');
    const stateFile = path.join(process.cwd(), 'data', 'state.json');
    const leads = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile)) : [];
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile)) : null;
    const { type, market, heat, limit = '500' } = req.query;
    let filtered = leads;
    if (type) filtered = filtered.filter(l => l.leadType === type.toUpperCase());
    if (market) filtered = filtered.filter(l => l.market === market.toUpperCase());
    if (heat) filtered = filtered.filter(l => l.heat === heat);
    res.json({
      leads: filtered.slice(0, parseInt(limit)),
      total: leads.length, state,
      hirers: leads.filter(l=>l.leadType==='HIRER').length,
      talent: leads.filter(l=>l.leadType==='TALENT').length,
      hot: leads.filter(l=>l.heat==='Hot').length,
      withEmail: leads.filter(l=>l.contactEmail).length,
    });
  } catch(e) { res.status(500).json({ error: e.message, leads: [], total: 0 }); }
}
