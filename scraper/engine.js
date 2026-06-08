'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
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

// ── HTTP Headers ──────────────────────────────────────────────────────────────
const UA_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const UA_MOBILE  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function hdrs(mobile = false, extra = {}) {
  return {
    'User-Agent': mobile ? UA_MOBILE : UA_DESKTOP,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
    ...extra,
  };
}

async function get(url, opts = {}) {
  return axios.get(url, { headers: hdrs(opts.mobile, opts.headers), timeout: opts.timeout || 12000, maxRedirects: 5 });
}

// ── Phone validation — STRICT ─────────────────────────────────────────────────
const FAKE_PHONE_PATS = [
  /^(\d)\1{6,}/,
  /^(12345|23456|01234|98765|55555|00000)/,
  /^0{6,}/, /^1{7,}/, /^9{7,}/,
];

function cleanPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[\s\-().]/g, '');
  const d = s.replace(/\D/g, '');
  if (d.length < 7 || d.length > 15) return null;
  if (FAKE_PHONE_PATS.some(p => p.test(d))) return null;
  // Reject 7+ consecutive repeating digit
  for (let i = 0; i <= d.length - 7; i++) {
    if ([...d.slice(i, i+7)].every(c => c === d[i])) return null;
  }
  return raw.trim();
}

function extractAllPhones(html, text) {
  const src = (html || '') + ' ' + (text || '');
  const found = new Set();

  // WhatsApp links — most reliable
  const waRe = /wa\.me\/(\+?[\d]{10,15})/g;
  let m;
  while ((m = waRe.exec(src)) !== null) {
    const p = cleanPhone(m[1]);
    if (p) found.add(p.startsWith('+') ? p : '+' + p);
  }

  // tel: href links
  const telRe = /href=["']tel:([^"']+)["']/g;
  while ((m = telRe.exec(src)) !== null) {
    const p = cleanPhone(m[1]);
    if (p) found.add(p);
  }

  // UAE mobile: +971 or 05X
  const uaeRe = /(?<!\d)((?:\+971|00971|0)5[024568][\s\-]?\d{3}[\s\-]?\d{4})(?!\d)/g;
  while ((m = uaeRe.exec(src)) !== null) {
    const p = cleanPhone(m[1]);
    if (p) found.add(p);
  }

  // UAE landline: +971 4/2/3/6/7/9
  const uaeLLRe = /(?<!\d)((?:\+971|00971)[\s\-]?(?:2|3|4|6|7|9)[\s\-]?\d{3}[\s\-]?\d{4})(?!\d)/g;
  while ((m = uaeLLRe.exec(src)) !== null) {
    const p = cleanPhone(m[1]);
    if (p) found.add(p);
  }

  // Lebanon: +961 or 0X
  const lbRe = /(?<!\d)((?:\+961|00961|0)(?:1|3|4|5|6|7|8|9)[\s\-]?\d{3}[\s\-]?\d{3,4})(?!\d)/g;
  while ((m = lbRe.exec(src)) !== null) {
    const p = cleanPhone(m[1]);
    if (p) found.add(p);
  }

  // USA: +1 XXX XXX XXXX
  const usRe = /(?:\+1[\s\-.]?)?\(?(2|3|4|5|6|7|8|9)\d{2}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}(?!\d)/g;
  while ((m = usRe.exec(src)) !== null) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length === 10 || digits.length === 11) {
      const p = cleanPhone(m[0]);
      if (p) found.add(p);
    }
  }

  return [...found].slice(0, 3);
}

function extractWhatsApp(html) {
  const m = (html || '').match(/wa\.me\/(\+?[\d]{10,15})/);
  if (!m) return null;
  const n = m[1];
  const p = cleanPhone(n);
  return p ? (n.startsWith('+') ? n : '+' + n) : null;
}

// ── Email validation ───────────────────────────────────────────────────────────
const PERSONAL_DOMAINS = ['gmail.com','hotmail.com','yahoo.com','outlook.com','icloud.com','protonmail.com','live.com','msn.com','aol.com','ymail.com'];
const SPAM_CONTAINS = ['noreply','no-reply','sentry','cloudflare','mailchimp','sendgrid','amazonaws','bounce','unsubscribe'];

function validateEmail(e) {
  if (!e) return null;
  const em = e.toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,6}(?=[^a-z]|$)/.test(em)) return null;
  if (PERSONAL_DOMAINS.some(d => em.endsWith('@'+d))) return null;
  if (SPAM_CONTAINS.some(s => em.includes(s))) return null;
  return em;
}

function extractEmails(text) {
  const raw = (text || '').match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}/g) || [];
  return raw.map(validateEmail).filter(Boolean);
}

// ── Lead classification ────────────────────────────────────────────────────────
const SALES_KWS = [
  'sales executive','sales manager','sales director','head of sales','vp sales',
  'business development','bdm','bdr','sdr','sales development',
  'account executive','account manager','key account',
  'marketing manager','marketing director','growth manager','demand generation',
  'commercial manager','commercial director','revenue manager',
  'field sales','inside sales','outbound sales','channel sales',
  'territory manager','partnerships manager','sales representative',
  'sales agent','trade marketing','retail sales','sales officer',
];

const EXCLUDE_KWS = [
  'developer','engineer','devops','data scientist','accountant',
  'doctor','nurse','driver','delivery','warehouse','receptionist',
  'teacher','cook','chef','cleaner','security guard',
];

const TALENT_SIGS = [
  'looking for work','open to work','seeking','i am available',
  'i have experience','years of experience','looking for job','need job',
  'seeking employment','open for opportunities',
];

const HIRER_SIGS = [
  'we are hiring','now hiring','join our team','we need','required',
  'vacancy','opening','job offer','apply now','send cv','send resume',
  'whatsapp your cv','send your cv','looking for candidate',
];

function classifyLead(title, body) {
  const text = ((title || '') + ' ' + (body || '')).toLowerCase();
  if (!SALES_KWS.some(k => text.includes(k))) return null;
  if (EXCLUDE_KWS.some(k => text.includes(k))) return null;
  const isTalent = TALENT_SIGS.some(s => text.includes(s));
  const isHirer  = HIRER_SIGS.some(s => text.includes(s));
  if (isTalent && !isHirer) return 'TALENT';
  return 'HIRER';
}

function detectMarket(text) {
  const t = (text || '').toLowerCase();
  if (['dubai','abu dhabi','sharjah','uae','emirates','ajman','ras al'].some(k => t.includes(k))) return 'UAE';
  if (['beirut','lebanon','liban','jounieh','tripoli','sidon'].some(k => t.includes(k))) return 'LEBANON';
  if (['usa','united states','new york','california','remote'].some(k => t.includes(k))) return 'USA';
  return 'UAE';
}

// ── Scoring ────────────────────────────────────────────────────────────────────
function scoreLead(lead) {
  let s = 0;
  const t = (lead.title || '').toLowerCase();
  if (/director|vp|head|chief/.test(t)) s += 30;
  else if (/manager|executive|lead/.test(t)) s += 20;
  else s += 10;

  const hrs = (Date.now() - new Date(lead.postedAt || Date.now()).getTime()) / 3600000;
  if (hrs < 1) s += 50; else if (hrs < 6) s += 40; else if (hrs < 24) s += 25; else if (hrs < 72) s += 10;

  if (lead.whatsapp) s += 40; // Direct WhatsApp = gold
  if (lead.phone)    s += 35; // Real phone number
  if (lead.email)    s += 20;
  if (lead.market === 'UAE') s += 15;
  if (lead.market === 'LEBANON') s += 12;
  if (lead.leadType === 'HIRER') s += 10;

  lead.score = s;
  lead.heat  = s >= 80 ? 'Hot' : s >= 55 ? 'Warm' : 'Cold';
  return lead;
}

function generateMessage(lead) {
  const co = lead.company || 'your company';
  const role = lead.title || 'the role';
  const contact = lead.whatsapp ? `WhatsApp: ${lead.whatsapp}`
    : lead.phone ? `Call/WhatsApp: ${lead.phone}`
    : lead.email ? `Email: ${lead.email}` : 'contact in CRM';

  if (lead.leadType === 'HIRER') {
    return `Hi — saw ${co} is hiring a ${role}. We place pre-vetted Sales & Marketing talent in 72 hours at 10% of annual salary — Lebanese professionals, multilingual, up to 50% more cost-effective. Worth a quick call? ${contact}`;
  }
  return `Hi — your Sales background looks like a strong match for active roles in ${lead.market === 'UAE' ? 'Dubai' : lead.market === 'USA' ? 'the US' : 'the region'}. Free for candidates. ${contact}`;
}

// ── ID + Dedup ─────────────────────────────────────────────────────────────────
function makeId(prefix, str) {
  return prefix + '_' + Buffer.from(str).toString('base64').replace(/[^a-zA-Z0-9]/g,'').slice(0,14);
}

function dedupKey(lead) {
  const co = (lead.company||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
  const ti = (lead.title||'').toLowerCase().replace(/\b(senior|junior|sr|jr)\b/g,'').replace(/[^a-z0-9]/g,'').slice(0,20);
  const ph = (lead.phone||lead.whatsapp||'').replace(/\D/g,'').slice(-8);
  return `${co}|${ti}|${ph}`;
}

// ── Persistence ────────────────────────────────────────────────────────────────
function loadLeads() {
  for (const f of [DATA_FILE, BACKUP_FILE]) {
    if (!fs.existsSync(f)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(d) && d.length > 0) { console.log(`Loaded ${d.length} from ${path.basename(f)}`); return d; }
    } catch {}
  }
  return [];
}

function saveLeads(leads) {
  if (!Array.isArray(leads) || leads.length === 0) { console.error('SAVE ABORTED — empty'); return false; }
  const existing = loadLeads();
  if (existing.length > 0 && leads.length < existing.length * 0.85) {
    console.error(`SAVE ABORTED — ${leads.length} < 85% of ${existing.length}`); return false;
  }
  if (fs.existsSync(DATA_FILE)) fs.copyFileSync(DATA_FILE, BACKUP_FILE);
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
  console.log(`Saved ${leads.length} leads`);
  return true;
}

function loadSet(file) {
  try { if (fs.existsSync(file)) return new Set(JSON.parse(fs.readFileSync(file))); } catch {}
  return new Set();
}
function saveSet(file, set) { fs.writeFileSync(file, JSON.stringify([...set])); }

// ════════════════════════════════════════════════════════════════════════════════
// SCRAPERS — classified ad sites with public phone numbers
// ════════════════════════════════════════════════════════════════════════════════

// 1. OPENSOOQ UAE — classifieds, every listing has call/WhatsApp button
async function scrapeOpenSooqUAE() {
  const leads = [];
  const listUrls = [
    'https://ae.opensooq.com/en/jobs/sales-marketing/sales-manager',
    'https://ae.opensooq.com/en/jobs/sales-marketing/sales-agent',
    'https://ae.opensooq.com/en/jobs/job-vacancies?q=sales+executive',
    'https://ae.opensooq.com/en/jobs/job-vacancies?q=business+development',
    'https://ae.opensooq.com/en/jobs/job-vacancies?q=marketing+manager',
  ];

  for (const listUrl of listUrls) {
    try {
      const { data } = await get(listUrl);
      const $ = cheerio.load(data);
      const links = new Set();
      $('a[href]').each((_, el) => {
        const h = $(el).attr('href') || '';
        if (h.match(/\/en\/jobs\/[a-z\-]+\/\d+/)) {
          links.add(h.startsWith('http') ? h : 'https://ae.opensooq.com' + h);
        }
      });

      for (const link of [...links].slice(0, 8)) {
        try {
          await sleep(500 + Math.random()*500);
          const { data: ld } = await get(link);
          const $l = cheerio.load(ld);
          const title = $l('h1').first().text().trim();
          const company = $l('[class*="shop-name"],[class*="user-name"],[class*="seller"]').first().text().trim();
          const desc = $l('[class*="description"],[class*="details"]').first().text().trim().slice(0,400);
          if (!title) continue;
          const lt = classifyLead(title, desc);
          if (!lt) continue;

          const phones = extractAllPhones(ld, $l.text());
          const wa = extractWhatsApp(ld);
          const telM = ld.match(/href=["']tel:([^"']+)["']/);
          const phone = telM ? cleanPhone(telM[1]) : (phones[0] || null);
          const emails = extractEmails($l.text());

          if (!phone && !wa && !emails[0]) continue;

          leads.push({
            id: makeId('osae', title + (company||'') + (phone||wa||'')),
            title: title.slice(0,100), company: company || 'OpenSooq Poster',
            location: 'Dubai, UAE', market: 'UAE',
            postedAt: new Date().toISOString(), link,
            source: 'OpenSooq UAE', leadType: lt,
            phone: phone || null, whatsapp: wa || null,
            email: emails[0] || null,
            description: desc,
            scrapedAt: new Date().toISOString(),
          });
        } catch {}
      }
      await sleep(1000);
    } catch (e) { console.error('OpenSooq UAE:', e.message); }
  }
  console.log(`  OpenSooq UAE: ${leads.length}`);
  return leads;
}

// 2. OPENSOOQ LEBANON
async function scrapeOpenSooqLB() {
  const leads = [];
  const listUrls = [
    'https://lb.opensooq.com/en/jobs/sales-marketing/sales-manager',
    'https://lb.opensooq.com/en/jobs/sales-marketing/sales-agent',
    'https://lb.opensooq.com/en/jobs/job-vacancies?q=sales',
    'https://lb.opensooq.com/en/jobs/job-vacancies?q=marketing+manager',
  ];

  for (const listUrl of listUrls) {
    try {
      const { data } = await get(listUrl);
      const $ = cheerio.load(data);
      const links = new Set();
      $('a[href]').each((_, el) => {
        const h = $(el).attr('href') || '';
        if (h.match(/\/en\/jobs\/[a-z\-]+\/\d+/)) {
          links.add(h.startsWith('http') ? h : 'https://lb.opensooq.com' + h);
        }
      });

      for (const link of [...links].slice(0, 6)) {
        try {
          await sleep(500 + Math.random()*500);
          const { data: ld } = await get(link);
          const $l = cheerio.load(ld);
          const title = $l('h1').first().text().trim();
          const company = $l('[class*="shop-name"],[class*="user-name"]').first().text().trim();
          const desc = $l('[class*="description"]').first().text().trim().slice(0,400);
          if (!title) continue;
          const lt = classifyLead(title, desc);
          if (!lt) continue;

          const phones = extractAllPhones(ld, $l.text());
          const wa = extractWhatsApp(ld);
          const telM = ld.match(/href=["']tel:([^"']+)["']/);
          const phone = telM ? cleanPhone(telM[1]) : (phones[0] || null);

          if (!phone && !wa) continue;

          leads.push({
            id: makeId('oslb', title + (company||'') + (phone||wa||'')),
            title: title.slice(0,100), company: company || 'OpenSooq Poster',
            location: 'Lebanon', market: 'LEBANON',
            postedAt: new Date().toISOString(), link,
            source: 'OpenSooq Lebanon', leadType: lt,
            phone: phone || null, whatsapp: wa || null,
            scrapedAt: new Date().toISOString(),
          });
        } catch {}
      }
      await sleep(1000);
    } catch (e) { console.error('OpenSooq LB:', e.message); }
  }
  console.log(`  OpenSooq Lebanon: ${leads.length}`);
  return leads;
}

// 3. DUBIZZLE UAE — classified jobs section
async function scrapeDubizzleUAE() {
  const leads = [];
  const listUrls = [
    'https://uae.dubizzle.com/jobs/sales/',
    'https://uae.dubizzle.com/jobs/marketing/',
    'https://uae.dubizzle.com/jobs/search/?q=sales+executive',
    'https://uae.dubizzle.com/jobs/search/?q=business+development+manager',
  ];

  for (const listUrl of listUrls) {
    try {
      const { data } = await get(listUrl);
      const $ = cheerio.load(data);
      const links = new Set();
      $('a[href]').each((_, el) => {
        const h = $(el).attr('href') || '';
        if (h.match(/\/jobs\/[^/]+\/[^/]+\/\d+/) || h.match(/\/classifieds\/[^/]+\/\d+/)) {
          links.add(h.startsWith('http') ? h : 'https://uae.dubizzle.com' + h);
        }
      });

      for (const link of [...links].slice(0, 8)) {
        try {
          await sleep(500 + Math.random()*500);
          const { data: ld } = await get(link);
          const $l = cheerio.load(ld);
          const title = $l('h1,[class*="title-"]').first().text().trim();
          const company = $l('[class*="company"],[class*="author"],[class*="seller"]').first().text().trim();
          const desc = $l('[class*="description"],[class*="details-text"]').first().text().trim().slice(0,400);
          if (!title) continue;
          const lt = classifyLead(title, desc);
          if (!lt) continue;

          const phones = extractAllPhones(ld, $l.text());
          const wa = extractWhatsApp(ld);
          const telM = ld.match(/href=["']tel:([^"']+)["']/);
          const phone = telM ? cleanPhone(telM[1]) : (phones[0] || null);
          const emails = extractEmails($l.text());

          if (!phone && !wa && !emails[0]) continue;

          leads.push({
            id: makeId('dub', title + (company||'') + (phone||wa||'')),
            title: title.slice(0,100), company: company || 'Dubizzle Poster',
            location: 'Dubai, UAE', market: 'UAE',
            postedAt: new Date().toISOString(), link,
            source: 'Dubizzle UAE', leadType: lt,
            phone: phone || null, whatsapp: wa || null,
            email: emails[0] || null, description: desc,
            scrapedAt: new Date().toISOString(),
          });
        } catch {}
      }
      await sleep(1000);
    } catch (e) { console.error('Dubizzle UAE:', e.message); }
  }
  console.log(`  Dubizzle UAE: ${leads.length}`);
  return leads;
}

// 4. DUBIZZLE LEBANON
async function scrapeDubizzleLB() {
  const leads = [];
  const listUrls = [
    'https://dubizzle.com.lb/en/jobs/sales/',
    'https://dubizzle.com.lb/en/jobs/marketing/',
    'https://dubizzle.com.lb/en/jobs/search/?q=sales',
  ];

  for (const listUrl of listUrls) {
    try {
      const { data } = await get(listUrl);
      const $ = cheerio.load(data);
      const links = new Set();
      $('a[href]').each((_, el) => {
        const h = $(el).attr('href') || '';
        if (h.match(/\/jobs\/[^/]+\/\d+/) || h.match(/\/en\/[^/]+\/\d+/)) {
          links.add(h.startsWith('http') ? h : 'https://dubizzle.com.lb' + h);
        }
      });

      for (const link of [...links].slice(0, 6)) {
        try {
          await sleep(500);
          const { data: ld } = await get(link);
          const $l = cheerio.load(ld);
          const title = $l('h1').first().text().trim();
          const desc = $l('[class*="description"]').first().text().trim().slice(0,400);
          if (!title) continue;
          const lt = classifyLead(title, desc);
          if (!lt) continue;

          const phones = extractAllPhones(ld, $l.text());
          const wa = extractWhatsApp(ld);
          const phone = phones[0] || null;
          if (!phone && !wa) continue;

          leads.push({
            id: makeId('dublb', title + (phone||wa||'')),
            title: title.slice(0,100), company: 'Dubizzle Poster',
            location: 'Lebanon', market: 'LEBANON',
            postedAt: new Date().toISOString(), link,
            source: 'Dubizzle Lebanon', leadType: lt,
            phone, whatsapp: wa,
            scrapedAt: new Date().toISOString(),
          });
        } catch {}
      }
      await sleep(1000);
    } catch (e) { console.error('Dubizzle LB:', e.message); }
  }
  console.log(`  Dubizzle Lebanon: ${leads.length}`);
  return leads;
}

// 5. OLX LEBANON
async function scrapeOLXLebanon() {
  const leads = [];
  const listUrls = [
    'https://www.olx.com.lb/en/jobs/sales-marketing-jobs/',
    'https://www.olx.com.lb/en/jobs/?q=sales+manager',
    'https://www.olx.com.lb/en/jobs/?q=business+development',
  ];

  for (const listUrl of listUrls) {
    try {
      const { data } = await get(listUrl);
      const $ = cheerio.load(data);
      const links = new Set();
      $('a[href*="/item/"]').each((_, el) => {
        const h = $(el).attr('href') || '';
        links.add(h.startsWith('http') ? h : 'https://www.olx.com.lb' + h);
      });

      for (const link of [...links].slice(0, 8)) {
        try {
          await sleep(500);
          const { data: ld } = await get(link);
          const $l = cheerio.load(ld);
          const title = $l('h1,[data-aut-id="itemTitle"]').first().text().trim();
          const desc = $l('[data-aut-id="itemDescription"],[class*="description"]').first().text().trim().slice(0,400);
          if (!title) continue;
          const lt = classifyLead(title, desc);
          if (!lt) continue;

          const phones = extractAllPhones(ld, $l.text());
          const wa = extractWhatsApp(ld);
          const phone = phones[0] || null;
          if (!phone && !wa) continue;

          leads.push({
            id: makeId('olxlb', title + (phone||wa||'')),
            title: title.slice(0,100), company: 'OLX Poster',
            location: 'Lebanon', market: 'LEBANON',
            postedAt: new Date().toISOString(), link,
            source: 'OLX Lebanon', leadType: lt,
            phone, whatsapp: wa, description: desc,
            scrapedAt: new Date().toISOString(),
          });
        } catch {}
      }
      await sleep(1000);
    } catch (e) { console.error('OLX Lebanon:', e.message); }
  }
  console.log(`  OLX Lebanon: ${leads.length}`);
  return leads;
}

// 6. EXPATRIATES.COM — UAE + Lebanon
async function scrapeExpatriates(market) {
  const leads = [];
  const base = market === 'LEBANON'
    ? 'https://www.expatriates.com/classifieds/leb'
    : 'https://www.expatriates.com/classifieds/uae';
  const listUrls = [`${base}/jobs/sales/`, `${base}/jobs/marketing/`, `${base}/jobs/`];

  for (const listUrl of listUrls) {
    try {
      const { data } = await get(listUrl);
      const $ = cheerio.load(data);
      const links = new Set();
      $('a[href*="/classifieds/"]').each((_, el) => {
        const h = $(el).attr('href') || '';
        if (h.match(/\/\d+\.html/)) links.add(h.startsWith('http') ? h : 'https://www.expatriates.com' + h);
      });

      for (const link of [...links].slice(0, 8)) {
        try {
          await sleep(500);
          const { data: ld } = await get(link);
          const $l = cheerio.load(ld);
          const title = $l('h1,h2').first().text().trim();
          const desc = $l('.classified-description,[class*="content"]').first().text().trim().slice(0,400);
          if (!title) continue;
          const lt = classifyLead(title, desc + ' ' + $l.text().slice(0,500));
          if (!lt) continue;

          const phones = extractAllPhones(ld, $l.text());
          const wa = extractWhatsApp(ld);
          const emails = extractEmails($l.text());
          const phone = phones[0] || null;
          if (!phone && !wa && !emails[0]) continue;

          leads.push({
            id: makeId('exp', title + (phone||wa||emails[0]||'')),
            title: title.slice(0,100),
            company: $l('[class*="poster"],[class*="company"]').first().text().trim() || 'Expatriates Poster',
            location: market === 'LEBANON' ? 'Lebanon' : 'UAE',
            market,
            postedAt: new Date().toISOString(), link,
            source: market === 'LEBANON' ? 'Expatriates Lebanon' : 'Expatriates UAE',
            leadType: lt,
            phone, whatsapp: wa, email: emails[0] || null,
            scrapedAt: new Date().toISOString(),
          });
        } catch {}
      }
      await sleep(1000);
    } catch (e) { console.error(`Expatriates ${market}:`, e.message); }
  }
  console.log(`  Expatriates ${market}: ${leads.length}`);
  return leads;
}

// 7. LAIMOON — UAE/Lebanon job board with recruiter numbers
async function scrapeLaimoon() {
  const leads = [];
  const listUrls = [
    'https://laimoon.com/jobs/sales-manager/ae',
    'https://laimoon.com/jobs/sales-executive/ae',
    'https://laimoon.com/jobs/business-development/ae',
    'https://laimoon.com/jobs/marketing-manager/ae',
    'https://laimoon.com/jobs/sales-manager/lb',
  ];

  for (const url of listUrls) {
    try {
      const { data } = await get(url);
      const $ = cheerio.load(data);

      $('[class*="job-item"],[class*="result-item"],article').each((_, el) => {
        const title = $(el).find('h2,h3,[class*="title"]').first().text().trim();
        const company = $(el).find('[class*="company"]').first().text().trim();
        const location = $(el).find('[class*="location"]').first().text().trim();
        const html = $(el).html() || '';
        const phones = extractAllPhones(html, $(el).text());
        const telEl = $(el).find('a[href^="tel:"]');
        const phone = (telEl.length ? cleanPhone((telEl.attr('href')||'').replace('tel:','')) : null) || phones[0] || null;
        const emails = extractEmails(html);
        const link = $(el).find('a').first().attr('href') || '';

        if (!title) return;
        const lt = classifyLead(title, '');
        if (!lt) return;
        if (!phone && !emails[0]) return;

        leads.push({
          id: makeId('laim', title + (company||'') + (phone||'')),
          title: title.slice(0,100), company: company || 'Unknown',
          location: location || (url.endsWith('/lb') ? 'Lebanon' : 'UAE'),
          market: detectMarket(location + ' ' + url),
          postedAt: new Date().toISOString(),
          link: link.startsWith('http') ? link : 'https://laimoon.com' + link,
          source: 'Laimoon', leadType: lt,
          phone, email: emails[0] || null,
          scrapedAt: new Date().toISOString(),
        });
      });
      await sleep(800);
    } catch (e) { console.error('Laimoon:', e.message); }
  }
  console.log(`  Laimoon: ${leads.length}`);
  return leads;
}

// 8. AKHTABOOT — Arab world job board
async function scrapeAkhtaboot() {
  const leads = [];
  const urls = [
    'https://www.akhtaboot.com/en/jobs/sales-marketing/uae',
    'https://www.akhtaboot.com/en/jobs/sales-marketing/lebanon',
    'https://www.akhtaboot.com/en/search?q=sales+executive&country=uae',
  ];

  for (const url of urls) {
    try {
      const { data } = await get(url);
      const $ = cheerio.load(data);

      $('[class*="job-card"],[class*="job-item"],.job').each((_, el) => {
        const title = $(el).find('h2 a,h3 a,[class*="title"]').first().text().trim();
        const company = $(el).find('[class*="company"]').first().text().trim();
        const location = $(el).find('[class*="location"]').first().text().trim();
        const html = $(el).html() || '';
        const phones = extractAllPhones(html, $(el).text());
        const emails = extractEmails(html);
        const link = $(el).find('a').first().attr('href') || '';
        if (!title) return;
        const lt = classifyLead(title, '');
        if (!lt) return;

        leads.push({
          id: makeId('akt', title + (company||'')),
          title: title.slice(0,100), company: company || 'Unknown',
          location: location || '',
          market: detectMarket(location + ' ' + url),
          postedAt: new Date().toISOString(),
          link: link.startsWith('http') ? link : 'https://www.akhtaboot.com' + link,
          source: 'Akhtaboot', leadType: lt,
          phone: phones[0] || null, email: emails[0] || null,
          scrapedAt: new Date().toISOString(),
        });
      });
      await sleep(800);
    } catch (e) { console.error('Akhtaboot:', e.message); }
  }
  console.log(`  Akhtaboot: ${leads.length}`);
  return leads;
}

// 9. GCC-JOBS.COM
async function scrapeGCCJobs() {
  const leads = [];
  const urls = [
    'https://gcc-jobs.com/jobs-in-uae/sales',
    'https://gcc-jobs.com/jobs-in-uae/marketing',
    'https://gcc-jobs.com/jobs-in-lebanon/sales',
  ];

  for (const url of urls) {
    try {
      const { data } = await get(url, { timeout: 10000 });
      const $ = cheerio.load(data);

      $('[class*="job"],article,.listing').each((_, el) => {
        const title = $(el).find('h2,h3,[class*="title"]').first().text().trim();
        const company = $(el).find('[class*="company"]').first().text().trim();
        const location = $(el).find('[class*="location"]').first().text().trim();
        const html = $(el).html() || '';
        const phones = extractAllPhones(html, $(el).text());
        const emails = extractEmails(html);
        const link = $(el).find('a').first().attr('href') || url;
        if (!title) return;
        const lt = classifyLead(title, '');
        if (!lt) return;
        if (!phones[0] && !emails[0]) return;

        leads.push({
          id: makeId('gcc', title + (phones[0]||'')),
          title: title.slice(0,100), company: company || 'Unknown',
          location: location || 'UAE',
          market: detectMarket(location + ' ' + url),
          postedAt: new Date().toISOString(),
          link: link.startsWith('http') ? link : 'https://gcc-jobs.com' + link,
          source: 'GCC Jobs', leadType: lt,
          phone: phones[0] || null, email: emails[0] || null,
          scrapedAt: new Date().toISOString(),
        });
      });
      await sleep(800);
    } catch (e) { console.error('GCC Jobs:', e.message); }
  }
  console.log(`  GCC Jobs: ${leads.length}`);
  return leads;
}

// 10. JOBSFORLEBANON.COM
async function scrapeJobsForLebanon() {
  const leads = [];
  const urls = [
    'https://www.jobsforlebanon.com/jobs/sales',
    'https://www.jobsforlebanon.com/jobs/marketing',
    'https://www.jobsforlebanon.com/jobs?q=business+development',
  ];

  for (const url of urls) {
    try {
      const { data } = await get(url, { timeout: 10000 });
      const $ = cheerio.load(data);

      $('[class*="job"],article,.card').each((_, el) => {
        const title = $(el).find('h2,h3,[class*="title"]').first().text().trim();
        const company = $(el).find('[class*="company"]').first().text().trim();
        const html = $(el).html() || '';
        const phones = extractAllPhones(html, $(el).text());
        const emails = extractEmails(html);
        const link = $(el).find('a').first().attr('href') || '';
        if (!title) return;
        const lt = classifyLead(title, '');
        if (!lt) return;

        leads.push({
          id: makeId('jfl', title + (company||'')),
          title: title.slice(0,100), company: company || 'Unknown',
          location: 'Lebanon', market: 'LEBANON',
          postedAt: new Date().toISOString(),
          link: link.startsWith('http') ? link : 'https://www.jobsforlebanon.com' + link,
          source: 'Jobs For Lebanon', leadType: lt,
          phone: phones[0] || null, email: emails[0] || null,
          scrapedAt: new Date().toISOString(),
        });
      });
      await sleep(800);
    } catch (e) { console.error('JobsForLebanon:', e.message); }
  }
  console.log(`  Jobs For Lebanon: ${leads.length}`);
  return leads;
}

// 11. HIRELEBANESE.COM
async function scrapeHireLebanese() {
  const leads = [];
  try {
    const { data } = await get('https://hirelebanese.com/jobs', { timeout: 10000 });
    const $ = cheerio.load(data);

    $('[class*="job"],.card,article').each((_, el) => {
      const title = $(el).find('h2,h3,[class*="title"]').first().text().trim();
      const company = $(el).find('[class*="company"]').first().text().trim();
      const html = $(el).html() || '';
      const phones = extractAllPhones(html, $(el).text());
      const emails = extractEmails(html);
      const link = $(el).find('a').first().attr('href') || '';
      if (!title) return;
      const lt = classifyLead(title, '');
      if (!lt) return;

      leads.push({
        id: makeId('hl', title + (company||'')),
        title: title.slice(0,100), company: company || 'Unknown',
        location: 'Lebanon', market: 'LEBANON',
        postedAt: new Date().toISOString(),
        link: link.startsWith('http') ? link : 'https://hirelebanese.com' + link,
        source: 'HireLebanese', leadType: lt,
        phone: phones[0] || null, email: emails[0] || null,
        scrapedAt: new Date().toISOString(),
      });
    });
  } catch (e) { console.error('HireLebanese:', e.message); }
  console.log(`  HireLebanese: ${leads.length}`);
  return leads;
}

// 12. BAYT — visit individual listings for emails/phones in descriptions
async function scrapeBayt(url, market) {
  const leads = [];
  try {
    const { data } = await get(url);
    const $ = cheerio.load(data);
    const links = new Set();
    $('a[href*="/job/"]').each((_, el) => {
      const h = $(el).attr('href') || '';
      links.add(h.startsWith('http') ? h : 'https://www.bayt.com' + h);
    });

    for (const link of [...links].slice(0, 6)) {
      try {
        await sleep(600);
        const { data: ld } = await get(link);
        const $l = cheerio.load(ld);
        const title = $l('h1').first().text().trim();
        const company = $l('[class*="jb-company"]').first().text().trim();
        const desc = $l('[class*="jb-descr"],[class*="jobDetails"]').first().text().trim().slice(0,500);
        if (!title) continue;
        const lt = classifyLead(title, desc);
        if (!lt) continue;

        const phones = extractAllPhones(ld, $l.text() + desc);
        const wa = extractWhatsApp(ld);
        const emails = extractEmails($l.text() + desc);
        const phone = phones[0] || null;
        if (!phone && !wa && !emails[0]) continue;

        leads.push({
          id: makeId('bayt', title + (company||'') + (phone||emails[0]||'')),
          title: title.slice(0,100), company: company || 'Unknown',
          location: market, market,
          postedAt: new Date().toISOString(), link,
          source: 'Bayt', leadType: lt,
          phone, whatsapp: wa || null, email: emails[0] || null,
          scrapedAt: new Date().toISOString(),
        });
      } catch {}
    }
    await sleep(1000);
  } catch (e) { console.error(`Bayt ${market}:`, e.message); }
  console.log(`  Bayt ${market}: ${leads.length}`);
  return leads;
}

// ── Strip contacts that appear on 3+ companies (artifacts) ────────────────────
function stripArtifacts(leads) {
  const phoneCnt = {}, emailCnt = {};
  leads.forEach(l => {
    if (l.phone) phoneCnt[l.phone] = (phoneCnt[l.phone]||0)+1;
    if (l.whatsapp) phoneCnt[l.whatsapp] = (phoneCnt[l.whatsapp]||0)+1;
    if (l.email) emailCnt[l.email] = (emailCnt[l.email]||0)+1;
  });
  let n = 0;
  leads.forEach(l => {
    if (l.phone && phoneCnt[l.phone] >= 3) { delete l.phone; n++; }
    if (l.whatsapp && phoneCnt[l.whatsapp] >= 3) { delete l.whatsapp; n++; }
    if (l.email && emailCnt[l.email] >= 3) { delete l.email; n++; }
  });
  if (n) console.log(`Stripped ${n} shared artifact contacts`);
  return leads;
}

// ── CRM push ───────────────────────────────────────────────────────────────────
async function pushToCRM(lead) {
  try {
    const payload = {
      name: lead.company,
      email: lead.email || '',
      enquiry_type: lead.leadType === 'HIRER' ? 'hire' : 'talent',
      role: lead.title,
      message: [
        `TYPE: ${lead.leadType} | HEAT: ${lead.heat} | SCORE: ${lead.score}`,
        `MARKET: ${lead.market} | SOURCE: ${lead.source}`,
        `LOCATION: ${lead.location}`,
        lead.phone    ? `PHONE: ${lead.phone}` : '',
        lead.whatsapp ? `WHATSAPP: ${lead.whatsapp}` : '',
        lead.email    ? `EMAIL: ${lead.email}` : '',
        `LINK: ${lead.link}`,
        '',
        'OUTREACH:',
        lead.message || '',
      ].filter(Boolean).join('\n'),
      source: 'lead_engine_auto',
      created_at: new Date().toISOString(),
    };
    const r = await axios.post(`${CRM_SUPABASE_URL}/rest/v1/website_leads`, payload, {
      headers: { 'Content-Type':'application/json', apikey: CRM_SUPABASE_KEY, Authorization:`Bearer ${CRM_SUPABASE_KEY}`, Prefer:'return=minimal' },
      timeout: 10000,
    });
    return r.status === 201 || r.status === 200;
  } catch { return false; }
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════════
async function runScrapeAndPush() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] ═══ Lead Engine (Phone-First) ═══`);

  const existing = loadLeads();
  const dedupIdx = loadSet(DEDUP_FILE);
  const pushedIds = loadSet(PUSHED_FILE);

  if (dedupIdx.size === 0 && existing.length > 0) {
    existing.forEach(l => dedupIdx.add(dedupKey(l)));
    saveSet(DEDUP_FILE, dedupIdx);
    console.log(`Built dedup index: ${dedupIdx.size} keys`);
  }

  // Run scrapers — sequential to avoid being blocked
  console.log('\nScraping phone-first sources...');
  const fresh = [];
  const scrapers = [
    scrapeOpenSooqUAE,
    scrapeOpenSooqLB,
    scrapeDubizzleUAE,
    scrapeDubizzleLB,
    scrapeOLXLebanon,
    () => scrapeExpatriates('UAE'),
    () => scrapeExpatriates('LEBANON'),
    scrapeLaimoon,
    scrapeAkhtaboot,
    scrapeGCCJobs,
    scrapeJobsForLebanon,
    scrapeHireLebanese,
    () => scrapeBayt('https://www.bayt.com/en/uae/jobs/sales-executive-jobs/', 'UAE'),
    () => scrapeBayt('https://www.bayt.com/en/uae/jobs/business-development-manager-jobs/', 'UAE'),
    () => scrapeBayt('https://www.bayt.com/en/lebanon/jobs/sales-manager-jobs/', 'LEBANON'),
  ];

  for (const scraper of scrapers) {
    try {
      const results = await scraper();
      fresh.push(...results);
    } catch (e) { console.error('Scraper error:', e.message); }
  }

  console.log(`\nRaw: ${fresh.length}`);

  // Dedup
  const batchSeen = new Set();
  const newLeads = fresh.filter(l => {
    const k = dedupKey(l);
    if (dedupIdx.has(k) || batchSeen.has(k)) return false;
    batchSeen.add(k); dedupIdx.add(k);
    return true;
  });
  console.log(`New (deduped): ${newLeads.length}`);

  // Score + message
  const scored = newLeads.map(l => { const s = scoreLead(l); s.message = generateMessage(s); return s; });

  // Strip artifacts, merge, sort, cap
  const merged = stripArtifacts([...scored, ...existing])
    .sort((a,b) => {
      const h = {Hot:0,Warm:1,Cold:2};
      if (h[a.heat] !== h[b.heat]) return h[a.heat]-h[b.heat];
      return (b.score||0)-(a.score||0);
    })
    .slice(0, 10000);

  saveLeads(merged);
  saveSet(DEDUP_FILE, dedupIdx);

  // CSV
  const csv = ['Type,Company,Title,Location,Market,Source,Heat,Score,Phone,WhatsApp,Email,Link',
    ...merged.map(l => [l.leadType,l.company,l.title,l.location,l.market,l.source,l.heat,l.score,l.phone||'',l.whatsapp||'',l.email||'',l.link]
      .map(v => `"${String(v||'').replace(/"/g,"'")}"`).join(','))
  ].join('\n');
  fs.writeFileSync(path.join(DATA_DIR,'leads.csv'), csv);

  // Push hot leads with contact info
  const toPush = scored.filter(l =>
    (l.heat === 'Hot' || (l.heat === 'Warm' && (l.phone || l.whatsapp))) &&
    !pushedIds.has(l.id) && (l.phone || l.whatsapp || l.email)
  );
  let pushed = 0;
  for (const lead of toPush) {
    if (await pushToCRM(lead)) { pushedIds.add(lead.id); pushed++; console.log(`  ✓ ${lead.company}`); }
    await sleep(300);
  }
  saveSet(PUSHED_FILE, pushedIds);

  const state = {
    lastRun: new Date().toISOString(),
    totalLeads: merged.length,
    newThisRun: scored.length,
    withPhone: merged.filter(l=>l.phone).length,
    withWhatsApp: merged.filter(l=>l.whatsapp).length,
    withEmail: merged.filter(l=>l.email).length,
    withAnyContact: merged.filter(l=>l.phone||l.whatsapp||l.email).length,
    hotLeads: merged.filter(l=>l.heat==='Hot').length,
    hirers: merged.filter(l=>l.leadType==='HIRER').length,
    talent: merged.filter(l=>l.leadType==='TALENT').length,
    uae: merged.filter(l=>l.market==='UAE').length,
    lebanon: merged.filter(l=>l.market==='LEBANON').length,
    pushedThisRun: pushed,
    totalPushed: pushedIds.size,
    durationSec: ((Date.now()-t0)/1000).toFixed(1),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`\n═══ DONE ${state.durationSec}s ═══`);
  console.log(`Total: ${state.totalLeads} | New: ${state.newThisRun}`);
  console.log(`Phone: ${state.withPhone} | WhatsApp: ${state.withWhatsApp} | Email: ${state.withEmail}`);
  console.log(`Hot: ${state.hotLeads} | Hirers: ${state.hirers} | Pushed: ${pushed}`);
  return state;
}

module.exports = { runScrapeAndPush };
if (require.main === module) runScrapeAndPush().catch(console.error);
