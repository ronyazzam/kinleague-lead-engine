'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Config ─────────────────────────────────────────────────────────────────────
const CRM_SUPABASE_URL = 'https://babhsufcvybimxysgvwb.supabase.co';
const CRM_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhYmhzdWZjdnliaW14eXNndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1OTk0MTgsImV4cCI6MjA5NjE3NTQxOH0.CgOQgPhLYD_FnTgF9Sm2NGETDll9dQT8gWCkFtpcsHc';
const DATA_DIR    = path.join(process.cwd(), 'data');
const DATA_FILE   = path.join(DATA_DIR, 'leads.json');
const BACKUP_FILE = path.join(DATA_DIR, 'leads.backup.json');
const PUSHED_FILE = path.join(DATA_DIR, 'pushed.json');
const STATE_FILE  = path.join(DATA_DIR, 'state.json');
const DEDUP_FILE  = path.join(DATA_DIR, 'dedup.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTTP ───────────────────────────────────────────────────────────────────────
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
async function get(url, opts = {}) {
  return axios.get(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8', 'Accept-Encoding': 'gzip, deflate, br', 'Cache-Control': 'no-cache', ...(opts.headers || {}) },
    timeout: opts.timeout || 13000, maxRedirects: 5,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });
}

// ── Phone validation ───────────────────────────────────────────────────────────
const FAKE_PATS = [/^(\d)\1{6,}/, /^(12345|23456|01234|98765|55555|00000)/, /^0{6,}/, /^1{7,}/, /^9{7,}/];
function cleanPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const d = raw.replace(/[\s\-().+]/g, '');
  if (d.length < 7 || d.length > 15) return null;
  if (FAKE_PATS.some(p => p.test(d))) return null;
  for (let i = 0; i <= d.length - 7; i++) if ([...d.slice(i, i+7)].every(c => c === d[i])) return null;
  return raw.trim();
}

function extractPhones(html, text) {
  const src = (html || '') + ' ' + (text || '');
  const found = new Set();
  for (const m of src.matchAll(/wa\.me\/(\+?[\d]{10,15})/g)) { const p = cleanPhone(m[1]); if (p) found.add(p.startsWith('+') ? p : '+' + p); }
  for (const m of src.matchAll(/href=["']tel:([^"']+)["']/g)) { const p = cleanPhone(m[1]); if (p) found.add(p); }
  for (const m of src.matchAll(/"phoneNumber":"([^"]+)"/g)) { const p = cleanPhone(m[1]); if (p) found.add(p); }
  for (const m of src.matchAll(/(?<!\d)((?:\+971|00971|0)5[024568][\s\-]?\d{3}[\s\-]?\d{4})(?!\d)/g)) { const p = cleanPhone(m[1]); if (p) found.add(p); }
  for (const m of src.matchAll(/(?<!\d)((?:\+971|00971)[\s\-]?(?:2|3|4|6|7|9)[\s\-]?\d{3}[\s\-]?\d{4})(?!\d)/g)) { const p = cleanPhone(m[1]); if (p) found.add(p); }
  for (const m of src.matchAll(/(?<!\d)((?:\+961|00961|0)(?:1|3|4|5|6|7|8|9)[\s\-]?\d{3}[\s\-]?\d{3,4})(?!\d)/g)) { const p = cleanPhone(m[1]); if (p) found.add(p); }
  for (const m of src.matchAll(/(?:\+1[\s\-.]?)?\(?(2|3|4|5|6|7|8|9)\d{2}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, ''); if (digits.length === 10 || digits.length === 11) { const p = cleanPhone(m[0]); if (p) found.add(p); }
  }
  return [...found].slice(0, 3);
}
function extractWhatsApp(html) { const m = (html||'').match(/wa\.me\/(\+?[\d]{10,15})/); if (!m) return null; const n = m[1]; return cleanPhone(n) ? (n.startsWith('+') ? n : '+'+n) : null; }

// ── Email ──────────────────────────────────────────────────────────────────────
const PERSONAL_DOMAINS = new Set(['gmail.com','hotmail.com','yahoo.com','outlook.com','icloud.com','protonmail.com','live.com','msn.com','aol.com','ymail.com']);
const SPAM_TOKENS = ['noreply','no-reply','sentry','cloudflare','mailchimp','sendgrid','amazonaws','bounce','unsubscribe','support@linkedin','@linkedin'];
function validateEmail(e) {
  if (!e) return null;
  const em = e.toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,6}(?=[^a-z]|$)/.test(em)) return null;
  if (PERSONAL_DOMAINS.has(em.split('@')[1])) return null;
  if (SPAM_TOKENS.some(t => em.includes(t))) return null;
  return em;
}
function extractEmails(text) { return ((text||'').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g)||[]).map(validateEmail).filter(Boolean); }

// ── Classification ─────────────────────────────────────────────────────────────
const SALES_KWS = [
  'sales executive','sales manager','sales director','head of sales','vp of sales','vp, sales','vp sales',
  'business development','bdm','bdr','sdr','sales development representative',
  'account executive','account manager','key account','national account',
  'marketing manager','marketing director','growth manager','demand generation',
  'commercial manager','commercial director','revenue manager','chief revenue',
  'field sales','inside sales','outbound sales','channel sales','b2b sales',
  'territory manager','partnerships manager','sales representative','sales rep',
  'sales agent','trade marketing','retail sales','sales officer','sales lead',
  'regional sales','area sales','district manager','zone manager',
  'مندوب مبيعات','مدير مبيعات','مدير تسويق','تسويق رقمي','مبيعات',
];
const EXCLUDE_KWS = [
  'developer','software engineer','devops','data scientist','data engineer','machine learning',
  'accountant','finance manager','lawyer','legal','doctor','nurse','physician',
  'driver','delivery','logistics','warehouse','receptionist','administrator',
  'teacher','cook','chef','cleaner','security guard','barista','waiter','cashier',
  'صيانة','نادل','وايتر','سائق','طباخ','حارس',
];
const TALENT_SIGS = ['looking for work','open to work','seeking a role','i am available','looking for job','seeking employment','باحث عن عمل','ابحث عن عمل'];
const HIRER_SIGS  = ['we are hiring','now hiring','join our team','we need','required','vacancy','job offer','apply now','send cv','send resume','مطلوب','نبحث عن'];

function classifyLead(title, body) {
  const text = ((title||'') + ' ' + (body||'')).toLowerCase();
  if (!SALES_KWS.some(k => text.includes(k))) return null;
  if (EXCLUDE_KWS.some(k => text.includes(k))) return null;
  if (TALENT_SIGS.some(s => text.includes(s)) && !HIRER_SIGS.some(s => text.includes(s))) return 'TALENT';
  return 'HIRER';
}
function detectMarket(text) {
  const t = (text||'').toLowerCase();
  if (['dubai','abu dhabi','sharjah','uae','emirates','ajman','ras al'].some(k => t.includes(k))) return 'UAE';
  if (['beirut','lebanon','liban','jounieh','tripoli','sidon'].some(k => t.includes(k))) return 'LEBANON';
  if (['usa','united states','new york','california','chicago','texas','remote us'].some(k => t.includes(k))) return 'USA';
  return 'UAE';
}

// ── Scoring ────────────────────────────────────────────────────────────────────
function scoreLead(lead) {
  let s = 0;
  const t = (lead.title||'').toLowerCase();
  if (/director|vp|head|chief|cro/.test(t)) s += 30;
  else if (/manager|executive|lead/.test(t)) s += 20;
  else s += 10;
  const hrs = (Date.now() - new Date(lead.postedAt||Date.now()).getTime()) / 3600000;
  if (hrs < 1) s += 50; else if (hrs < 6) s += 40; else if (hrs < 24) s += 25; else if (hrs < 72) s += 10;
  if (lead.whatsapp) s += 40;
  if (lead.phone)    s += 35;
  if (lead.email)    s += 20;
  if (lead.market === 'UAE')     s += 15;
  if (lead.market === 'LEBANON') s += 12;
  if (lead.leadType === 'HIRER') s += 10;
  lead.score = s;
  lead.heat  = s >= 80 ? 'Hot' : s >= 55 ? 'Warm' : 'Cold';
  return lead;
}
function generateMessage(lead) {
  const co   = lead.company || 'your company';
  const role = lead.title   || 'the role';
  const mkt  = lead.market === 'UAE' ? 'Dubai' : lead.market === 'USA' ? 'the US' : 'the region';
  const cta  = lead.whatsapp ? `WhatsApp: ${lead.whatsapp}` : lead.phone ? `Call/WhatsApp: ${lead.phone}` : lead.email ? `Email: ${lead.email}` : 'see CRM';
  if (lead.leadType === 'HIRER') return `Hi — saw ${co} is hiring a ${role}. We place pre-vetted Sales & Marketing talent in 72h at 10% annual salary — Lebanese professionals, multilingual, up to 50% more cost-effective. Worth a quick call? ${cta}`;
  return `Hi — your Sales background looks like a strong match for active roles in ${mkt}. Completely free for candidates. ${cta}`;
}

// ── ID & dedup ─────────────────────────────────────────────────────────────────
function makeId(prefix, str) { return prefix + '_' + Buffer.from(str).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,14); }
function dedupKey(lead) {
  const co = (lead.company||'').toLowerCase().replace(/\b(llc|ltd|inc|corp|co|group|holding|s\.a\.l\.?)\b/g,'').replace(/[^a-z0-9]/g,'').slice(0,20);
  const ti = (lead.title||'').toLowerCase().replace(/\b(senior|junior|sr|jr|associate)\b/g,'').replace(/[^a-z0-9]/g,'').slice(0,20);
  const ph = (lead.phone||lead.whatsapp||'').replace(/\D/g,'').slice(-8);
  return `${co}|${ti}|${ph}`;
}

// ── Persistence ────────────────────────────────────────────────────────────────
function loadLeads() {
  for (const f of [DATA_FILE, BACKUP_FILE]) {
    if (!fs.existsSync(f)) continue;
    try { const d = JSON.parse(fs.readFileSync(f,'utf8')); if (Array.isArray(d) && d.length > 0) { console.log(`Loaded ${d.length} from ${path.basename(f)}`); return d; } } catch {}
  }
  return [];
}
function saveLeads(leads) {
  if (!Array.isArray(leads) || leads.length === 0) { console.error('SAVE ABORTED — empty'); return false; }
  const ex = loadLeads();
  if (ex.length > 0 && leads.length < ex.length * 0.85) { console.error(`SAVE ABORTED — ${leads.length} < 85% of ${ex.length}`); return false; }
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
  console.log(`Saved ${leads.length} leads`); return true;
}
function loadSet(file) { try { if (fs.existsSync(file)) return new Set(JSON.parse(fs.readFileSync(file))); } catch {} return new Set(); }
function saveSet(file, set) { fs.writeFileSync(file, JSON.stringify([...set])); }

// ── Company enrichment (DuckDuckGo → website → phone) ─────────────────────────
const JOB_BOARD_DOMAINS = new Set(['linkedin.com','indeed.com','glassdoor.com','bayt.com','naukrigulf.com','monster.com','ziprecruiter.com','gulftalent.com','akhtaboot.com','laimoon.com','wuzzuf.net','hirelebanese.com','olx.com','dubizzle.com','opensooq.com','expatriates.com','remoteok.com','wellfound.com','snaphunt.com','google.com','bing.com','duckduckgo.com','yahoo.com','builtin.com']);

async function enrichWithPhone(lead) {
  if (lead.phone || lead.whatsapp) return lead;
  const company = lead.company;
  if (!company || company.length < 3 || ['unknown','lebanon employer','confidential'].includes(company.toLowerCase())) return lead;

  // DuckDuckGo (no rate-limit)
  try {
    const q = encodeURIComponent(`"${company}" contact`);
    const { data } = await get(`https://html.duckduckgo.com/html/?q=${q}`, { timeout: 9000, headers: { 'Accept': 'text/html' } });
    const $ = cheerio.load(data);
    let domain = null;
    const words = company.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    $('.result__url, .result__extras__url').each((_, el) => {
      if (domain) return;
      const txt = $(el).text().trim().replace(/^https?:\/\//, '');
      const d = txt.split('/')[0].replace(/^www\./, '');
      if (d && !JOB_BOARD_DOMAINS.has(d) && words.some(w => d.includes(w))) domain = d;
    });
    if (domain) {
      for (const url of [`https://www.${domain}/contact`, `https://www.${domain}/contact-us`, `https://${domain}`]) {
        try {
          const { data: html } = await get(url, { timeout: 8000 });
          const $ = cheerio.load(html);
          const phones = extractPhones(html, $.text());
          const wa     = extractWhatsApp(html);
          const emails = extractEmails($.text());
          if (phones[0]) { lead.phone = phones[0]; return lead; }
          if (wa)        { lead.whatsapp = wa; return lead; }
          if (emails[0] && !lead.email) lead.email = emails[0];
        } catch {}
      }
    }
  } catch {}
  return lead;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCRAPER 1 — OLX LEBANON  (VERIFIED: real +961 phones in every listing)
// ══════════════════════════════════════════════════════════════════════════════
async function scrapeOLXLebanon() {
  const leads = [];
  const allLinks = new Set();
  for (const pageUrl of ['https://www.olx.com.lb/en/jobs/','https://www.olx.com.lb/en/jobs/?page=2','https://www.olx.com.lb/en/jobs/?page=3']) {
    try {
      const { data } = await get(pageUrl);
      for (const m of data.matchAll(/href="(\/ad\/[^"]+ID\d+[^"]*\.html)"/g)) allLinks.add('https://www.olx.com.lb' + m[1]);
      await sleep(400);
    } catch {}
  }
  console.log(`  OLX Lebanon: ${allLinks.size} ads`);
  for (const link of [...allLinks]) {
    try {
      await sleep(300 + Math.random()*300);
      const { data: html } = await get(link);
      const titles = [...html.matchAll(/"title":"([^"]{5,100})"/g)].map(m => m[1].replace(/\\u([\dA-Fa-f]{4})/g,(_,h)=>String.fromCharCode(parseInt(h,16))).trim());
      const descs  = [...html.matchAll(/"description":"([^"]{10,800})"/g)].map(m => m[1]);
      const rawTitle = titles.find(t => t.length > 5 && !/olx|jobs in/i.test(t)) || '';
      const title    = rawTitle.replace(/\s*-\s*Jobs Available\s*-\s*\d+\s*/gi,'').replace(/\s*-\s*\d{8,}\s*$/,'').trim();
      const desc     = descs[0] || '';
      if (!title) continue;
      const lt = classifyLead(title, desc);
      if (!lt) continue;
      const phoneM = html.match(/"phoneNumber":"([^"]+)"/);
      const phone  = phoneM ? cleanPhone(phoneM[1]) : (extractPhones(html,'')[0]||null);
      const wa     = extractWhatsApp(html);
      const emails = extractEmails(html);
      if (!phone && !wa && !emails[0]) continue;
      leads.push({
        id: makeId('olxlb', title+(phone||wa||'')),
        title: title.slice(0,100),
        company: desc.match(/([A-Z][A-Za-z]+ (?:Company|Group|LLC|Ltd|Corp|SAL|s\.a\.l\.))/)?.[1] || 'Lebanon Employer',
        location: 'Lebanon', market: 'LEBANON',
        postedAt: new Date().toISOString(), link, source: 'OLX Lebanon', leadType: lt,
        phone: phone||null, whatsapp: wa||null, email: emails[0]||null,
        description: desc.slice(0,300), scrapedAt: new Date().toISOString(),
      });
    } catch {}
  }
  console.log(`  OLX Lebanon: ${leads.length} sales leads`);
  return leads;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCRAPER 2 — LINKEDIN  (proven: 14-59 leads per query)
// ══════════════════════════════════════════════════════════════════════════════
async function scrapeLinkedIn(query, location, market, max = 15) {
  const leads = [];
  const enc = encodeURIComponent;
  const urls = [
    `https://www.linkedin.com/jobs/search/?keywords=${enc(query)}&location=${enc(location)}&f_TPR=r86400&sortBy=DD`,
    `https://www.linkedin.com/jobs/search/?keywords=${enc(query)}&location=${enc(location)}&f_TPR=r3600`,
  ];
  for (const url of urls) {
    if (leads.length >= max) break;
    try {
      const { data } = await get(url);
      const $ = cheerio.load(data);
      $('div.base-card, li.jobs-search-results__list-item').each((_, el) => {
        if (leads.length >= max) return;
        const title   = $(el).find('.base-search-card__title, h3').first().text().trim();
        const company = $(el).find('.base-search-card__subtitle, h4').first().text().trim();
        const loc     = $(el).find('.job-search-card__location, .base-search-card__metadata').first().text().trim();
        const link    = $(el).find('a').first().attr('href') || '';
        const postedAt = $(el).find('time').attr('datetime') || new Date().toISOString();
        if (!title || !company) return;
        const lt = classifyLead(title, '');
        if (!lt) return;
        leads.push({
          id: makeId('li', title+company+market),
          title: title.slice(0,100), company: company.slice(0,80),
          location: loc||location, market, postedAt,
          link: link.split('?')[0], source: 'LinkedIn', leadType: lt,
          phone: null, whatsapp: null, email: null, scrapedAt: new Date().toISOString(),
        });
      });
      await sleep(700);
    } catch (e) { console.error(`LinkedIn ${query}:`, e.message.slice(0,50)); }
  }
  return leads.slice(0, max);
}

// ══════════════════════════════════════════════════════════════════════════════
// SCRAPER 3 — REMOTEOK  (JSON API, no auth needed, real companies)
// ══════════════════════════════════════════════════════════════════════════════
async function scrapeRemoteOK() {
  const leads = [];
  try {
    const { data } = await get('https://remoteok.com/remote-sales-jobs.json', { headers: { 'Accept': 'application/json' }, timeout: 12000 });
    const jobs = Array.isArray(data) ? data.slice(1) : []; // first item is metadata
    for (const job of jobs) {
      if (!job.position && !job.company) continue;
      const title   = (job.position || '').trim();
      const company = (job.company  || '').trim();
      const desc    = (job.description || job.tags?.join(' ') || '').replace(/<[^>]*>/g, ' ').slice(0, 400);
      if (!title || !company) continue;
      const lt = classifyLead(title, desc);
      if (!lt) continue;
      const html     = job.description || '';
      const phones   = extractPhones(html, desc);
      const wa       = extractWhatsApp(html);
      const emails   = extractEmails(html + ' ' + desc);
      leads.push({
        id: makeId('rok', title+company),
        title: title.slice(0,100), company: company.slice(0,80),
        location: 'Remote (USA)', market: 'USA',
        postedAt: (() => { try { const d = job.date ? new Date(Number(job.date) * 1000) : new Date(); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); } catch { return new Date().toISOString(); } })(),
        link: job.url || `https://remoteok.com/l/${job.id}`,
        source: 'RemoteOK', leadType: lt,
        phone: phones[0]||null, whatsapp: wa||null, email: emails[0]||null,
        scrapedAt: new Date().toISOString(),
      });
    }
  } catch (e) { console.error('RemoteOK:', e.message.slice(0,50)); }
  console.log(`  RemoteOK: ${leads.length}`);
  return leads;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCRAPER 4 — AKHTABOOT  (Arab jobs)
// ══════════════════════════════════════════════════════════════════════════════
async function scrapeAkhtaboot() {
  const leads = [];
  for (const [url, market] of [['https://www.akhtaboot.com/en/jobs-in-uae','UAE'],['https://www.akhtaboot.com/en/jobs-in-lebanon','LEBANON']]) {
    try {
      const { data } = await get(url, { timeout: 10000 });
      const $ = cheerio.load(data);
      $('div.job_details, [class*="job-card"], article').each((_, el) => {
        const title   = $(el).find('h2 a, h3 a, [class*="title"]').first().text().trim();
        const company = $(el).find('[class*="company"]').first().text().trim();
        const loc     = $(el).find('[class*="location"]').first().text().trim();
        const link    = $(el).find('a').first().attr('href') || '';
        if (!title) return;
        const lt = classifyLead(title, '');
        if (!lt) return;
        leads.push({
          id: makeId('akt', title+company),
          title: title.slice(0,100), company: company||'Unknown',
          location: loc||(market==='UAE'?'UAE':'Lebanon'), market,
          postedAt: new Date().toISOString(),
          link: link.startsWith('http') ? link : 'https://www.akhtaboot.com'+link,
          source: 'Akhtaboot', leadType: lt,
          phone: null, email: null, scrapedAt: new Date().toISOString(),
        });
      });
      await sleep(700);
    } catch (e) { console.error('Akhtaboot:', e.message.slice(0,50)); }
  }
  console.log(`  Akhtaboot: ${leads.length}`);
  return leads;
}

// ── Strip artifacts ────────────────────────────────────────────────────────────
function stripArtifacts(leads) {
  const cnt = {};
  leads.forEach(l => { if (l.phone) cnt[l.phone]=(cnt[l.phone]||0)+1; if (l.whatsapp) cnt[l.whatsapp]=(cnt[l.whatsapp]||0)+1; if (l.email) cnt[l.email]=(cnt[l.email]||0)+1; });
  let stripped = 0;
  leads.forEach(l => { if (l.phone&&cnt[l.phone]>=3){delete l.phone;stripped++;} if (l.whatsapp&&cnt[l.whatsapp]>=3){delete l.whatsapp;stripped++;} if (l.email&&cnt[l.email]>=3){delete l.email;stripped++;} });
  if (stripped) console.log(`Stripped ${stripped} shared artifacts`);
  return leads;
}

// ── CRM push ──────────────────────────────────────────────────────────────────
async function pushToCRM(lead) {
  try {
    const r = await axios.post(`${CRM_SUPABASE_URL}/rest/v1/website_leads`, {
      name: lead.company, email: lead.email||'',
      enquiry_type: lead.leadType==='HIRER' ? 'hire' : 'talent', role: lead.title,
      message: [`TYPE: ${lead.leadType} | HEAT: ${lead.heat} | SCORE: ${lead.score}`,`MARKET: ${lead.market} | SOURCE: ${lead.source}`,lead.phone?`PHONE: ${lead.phone}`:'',lead.whatsapp?`WHATSAPP: ${lead.whatsapp}`:'',lead.email?`EMAIL: ${lead.email}`:'',`LINK: ${lead.link}`,'','OUTREACH:',lead.message||''].filter(Boolean).join('\n'),
      source: 'lead_engine_auto', created_at: new Date().toISOString(),
    }, { headers: {'Content-Type':'application/json',apikey:CRM_SUPABASE_KEY,Authorization:`Bearer ${CRM_SUPABASE_KEY}`,Prefer:'return=minimal'}, timeout:10000 });
    return r.status===201||r.status===200;
  } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// Target: 100+ new leads per run via 12+ LinkedIn query combos + OLX + RemoteOK
// ══════════════════════════════════════════════════════════════════════════════
async function runScrapeAndPush() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] ═══ Lead Engine ═══`);

  const existing  = loadLeads();
  const dedupIdx  = loadSet(DEDUP_FILE);
  const pushedIds = loadSet(PUSHED_FILE);

  if (dedupIdx.size === 0 && existing.length > 0) {
    existing.forEach(l => dedupIdx.add(dedupKey(l)));
    saveSet(DEDUP_FILE, dedupIdx); console.log(`Built dedup index: ${dedupIdx.size}`);
  }

  console.log('\nScraping...');
  const fresh = [];

  // ── OLX Lebanon — real phones guaranteed ──
  fresh.push(...await scrapeOLXLebanon());

  // ── LinkedIn — 12 query combos targeting 100+ raw leads ──
  const liQueries = [
    // UAE
    ['sales executive',              'Dubai, UAE',           'UAE', 15],
    ['sales director',               'United Arab Emirates', 'UAE', 15],
    ['business development manager', 'Dubai, UAE',           'UAE', 15],
    ['account executive',            'Dubai, UAE',           'UAE', 12],
    ['marketing manager',            'Dubai, UAE',           'UAE', 12],
    ['head of sales',                'UAE',                  'UAE', 10],
    ['commercial director',          'United Arab Emirates', 'UAE', 10],
    ['sales manager',                'Abu Dhabi, UAE',       'UAE', 10],
    ['growth manager',               'Dubai, UAE',           'UAE', 10],
    // Lebanon
    ['sales manager',                'Lebanon',              'LEBANON', 10],
    ['business development',         'Beirut, Lebanon',      'LEBANON', 10],
    // USA remote
    ['vp of sales',                  'United States',        'USA', 12],
    ['sales director',               'United States',        'USA', 12],
    ['account executive',            'United States',        'USA', 10],
    ['chief revenue officer',        'United States',        'USA', 8],
  ];

  for (const [query, location, market, max] of liQueries) {
    const r = await scrapeLinkedIn(query, location, market, max);
    fresh.push(...r);
    console.log(`  LinkedIn ${market} "${query}": ${r.length}`);
    await sleep(600);
  }

  // ── RemoteOK — JSON API ──
  fresh.push(...await scrapeRemoteOK());
  await sleep(500);

  // ── Akhtaboot — Arab jobs ──
  fresh.push(...await scrapeAkhtaboot());

  console.log(`\nRaw: ${fresh.length}`);

  // Dedup
  const seen = new Set();
  const newLeads = fresh.filter(l => {
    const k = dedupKey(l);
    if (dedupIdx.has(k) || seen.has(k)) return false;
    seen.add(k); dedupIdx.add(k); return true;
  });
  console.log(`New (deduped): ${newLeads.length}`);

  const scored = newLeads.map(l => { const s = scoreLead(l); s.message = generateMessage(s); return s; });

  // Enrich LinkedIn/RemoteOK leads with company phone (up to 40)
  const needsEnrich = scored.filter(l => !l.phone && !l.whatsapp && l.source !== 'OLX Lebanon');
  console.log(`\nEnriching ${Math.min(needsEnrich.length, 40)} leads...`);
  let enriched = 0;
  for (const lead of needsEnrich.slice(0, 40)) {
    await enrichWithPhone(lead);
    if (lead.phone || lead.whatsapp || lead.email) process.stdout.write(` ${++enriched}`);
    await sleep(400);
  }
  if (enriched) console.log();

  // Merge + sort + cap
  const merged = stripArtifacts([...scored, ...existing])
    .sort((a, b) => { const h={Hot:0,Warm:1,Cold:2}; return h[a.heat]!==h[b.heat] ? h[a.heat]-h[b.heat] : (b.score||0)-(a.score||0); })
    .slice(0, 10000);

  saveLeads(merged);
  saveSet(DEDUP_FILE, dedupIdx);

  // CSV
  const csv = ['Type,Company,Title,Location,Market,Source,Heat,Score,Phone,WhatsApp,Email,Link',
    ...merged.map(l => [l.leadType,l.company,l.title,l.location,l.market,l.source,l.heat,l.score,l.phone||'',l.whatsapp||'',l.email||'',l.link].map(v=>`"${String(v||'').replace(/"/g,"'")}"`).join(','))
  ].join('\n');
  fs.writeFileSync(path.join(DATA_DIR,'leads.csv'), csv);

  // Push hot leads
  const toPush = scored.filter(l => (l.heat==='Hot'||(l.heat==='Warm'&&(l.phone||l.whatsapp))) && !pushedIds.has(l.id) && (l.phone||l.whatsapp||l.email));
  let pushed = 0;
  for (const lead of toPush) {
    if (await pushToCRM(lead)) { pushedIds.add(lead.id); pushed++; console.log(`  ✓ ${lead.company}`); }
    await sleep(300);
  }
  saveSet(PUSHED_FILE, pushedIds);

  const state = {
    lastRun: new Date().toISOString(), totalLeads: merged.length, newThisRun: scored.length,
    withPhone: merged.filter(l=>l.phone).length, withWhatsApp: merged.filter(l=>l.whatsapp).length,
    withEmail: merged.filter(l=>l.email).length, withAnyContact: merged.filter(l=>l.phone||l.whatsapp||l.email).length,
    hotLeads: merged.filter(l=>l.heat==='Hot').length, hirers: merged.filter(l=>l.leadType==='HIRER').length,
    talent: merged.filter(l=>l.leadType==='TALENT').length, uae: merged.filter(l=>l.market==='UAE').length,
    lebanon: merged.filter(l=>l.market==='LEBANON').length,
    pushedThisRun: pushed, totalPushed: pushedIds.size, durationSec: ((Date.now()-t0)/1000).toFixed(1),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`\n═══ DONE ${state.durationSec}s ═══`);
  console.log(`Total: ${state.totalLeads} | New: ${state.newThisRun}`);
  console.log(`📞 Phone: ${state.withPhone} | 💬 WA: ${state.withWhatsApp} | 📧 Email: ${state.withEmail}`);
  console.log(`🔥 Hot: ${state.hotLeads} | Hirers: ${state.hirers} | Pushed: ${pushed}`);
  return state;
}

module.exports = { runScrapeAndPush };
if (require.main === module) runScrapeAndPush().catch(console.error);
