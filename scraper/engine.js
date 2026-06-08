'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ─── Paths ───────────────────────────────────────────────────────────────────
const DATA_DIR    = path.join(process.cwd(), 'data');
const DATA_FILE   = path.join(DATA_DIR, 'leads.json');
const BACKUP_FILE = path.join(DATA_DIR, 'leads.backup.json');
const PUSHED_FILE = path.join(DATA_DIR, 'pushed.json');
const STATE_FILE  = path.join(DATA_DIR, 'state.json');
const DEDUP_FILE  = path.join(DATA_DIR, 'dedup_index.json');

const CRM_URL = 'https://babhsufcvybimxysgvwb.supabase.co';
const CRM_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhYmhzdWZjdnliaW14eXNndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1OTk0MTgsImV4cCI6MjA5NjE3NTQxOH0.CgOQgPhLYD_FnTgF9Sm2NGETDll9dQT8gWCkFtpcsHc';

const MIN_NEW_LEADS = 20;
const MAX_ENRICH    = 50;
const MAX_TOTAL     = 10000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Data persistence — BULLETPROOF ─────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadLeads() {
  ensureDir();
  for (const f of [DATA_FILE, BACKUP_FILE]) {
    if (!fs.existsSync(f)) continue;
    try {
      const leads = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(leads) && leads.length > 0) {
        console.log(`Loaded ${leads.length} leads from ${path.basename(f)}`);
        return leads;
      }
    } catch (e) { console.error(`Failed to parse ${path.basename(f)}:`, e.message); }
  }
  console.log('No existing leads — starting fresh');
  return [];
}

function saveLeads(leads) {
  ensureDir();
  if (!Array.isArray(leads) || leads.length === 0) {
    console.error('SAVE ABORTED: empty array — would delete all data');
    return false;
  }
  // Sanity check: never drop more than 20% in one run
  if (fs.existsSync(DATA_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(existing) && leads.length < existing.length * 0.8) {
        console.error(`SAVE ABORTED: new ${leads.length} < 80% of existing ${existing.length}`);
        return false;
      }
      fs.copyFileSync(DATA_FILE, BACKUP_FILE);
    } catch {}
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
  console.log(`Saved ${leads.length} leads`);
  return true;
}

function loadDedup() {
  ensureDir();
  try { if (fs.existsSync(DEDUP_FILE)) return new Set(JSON.parse(fs.readFileSync(DEDUP_FILE))); } catch {}
  return new Set();
}
function saveDedup(s) { ensureDir(); fs.writeFileSync(DEDUP_FILE, JSON.stringify([...s])); }

function loadPushed() {
  ensureDir();
  try { if (fs.existsSync(PUSHED_FILE)) return new Set(JSON.parse(fs.readFileSync(PUSHED_FILE))); } catch {}
  return new Set();
}
function savePushed(s) { ensureDir(); fs.writeFileSync(PUSHED_FILE, JSON.stringify([...s])); }

// ─── Deduplication ───────────────────────────────────────────────────────────
function makeDedupKey(lead) {
  const co = (lead.company || '')
    .toLowerCase()
    .replace(/\b(llc|ltd|inc|fze|fzc|llp|corp|co|group|holding|holdings|international|intl)\b/gi, '')
    .replace(/[^a-z0-9]/g, '');
  const ti = (lead.title || '')
    .toLowerCase()
    .replace(/\b(senior|junior|sr|jr|mid|level|experienced|lead)\b/gi, '')
    .replace(/[^a-z0-9]/g, '');
  const lo = (lead.location || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 6);
  return `${co}|${ti}|${lo}`;
}

function cleanDuplicates(leads) {
  const seen = new Set();
  const out = leads.filter(l => {
    const k = makeDedupKey(l);
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (out.length < leads.length) console.log(`Cleaned ${leads.length - out.length} duplicates`);
  return out;
}

function filterNew(existing, incoming, dedupIdx) {
  const base = new Set([...existing.map(makeDedupKey), ...dedupIdx]);
  const batchSeen = new Set();
  return incoming.filter(l => {
    const k = makeDedupKey(l);
    if (base.has(k) || batchSeen.has(k)) return false;
    base.add(k); batchSeen.add(k); dedupIdx.add(k);
    return true;
  });
}

// ─── Phone validation ────────────────────────────────────────────────────────
// STRICT: only accept numbers that begin with a known country code or UAE local format.
// This prevents Unix timestamps, IDs, and random digit strings from being captured.

function validatePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\s\-().]/g, '').trim();
  const digits = cleaned.replace(/\D/g, '');

  // Length gate
  if (digits.length < 8 || digits.length > 15) return null;

  // UAE mobile local: 05X XXXXXXX → 11 digits including leading 0
  if (/^05[024568]\d{7}$/.test(cleaned)) {
    return '+971' + cleaned.slice(1); // 0501234567 → +971501234567
  }

  // Must start with explicit country code — NO exceptions
  const CC_MAP = {
    '+971': '+971',   // UAE
    '00971': '+971',
    '+961': '+961',   // Lebanon
    '00961': '+961',
    '+1':   '+1',     // USA/Canada
    '+966': '+966',   // Saudi
    '+965': '+965',   // Kuwait
    '+974': '+974',   // Qatar
    '+973': '+973',   // Bahrain
    '+968': '+968',   // Oman
    '+20':  '+20',    // Egypt
  };

  const matchedCC = Object.keys(CC_MAP).find(cc => cleaned.startsWith(cc));
  if (!matchedCC) return null; // No known country code → REJECT

  // After country code, must have 6-12 more digits
  const afterCC = digits.slice(matchedCC.replace(/\D/g,'').length);
  if (afterCC.length < 6 || afterCC.length > 12) return null;

  // Reject all-same-digit and sequential patterns
  if (/^(\d)\1{5,}$/.test(digits)) return null;
  let seq = 0;
  for (let i = 1; i < digits.length; i++) {
    if (+digits[i] === +digits[i-1] + 1) { if (++seq >= 5) return null; }
    else seq = 0;
  }

  // Normalize to + prefix
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  return cleaned.startsWith('+') ? cleaned : '+' + cleaned;
}

function extractPhones(text) {
  // STRICT patterns — only with explicit country code or UAE local
  const patterns = [
    /\+971[\s\-]?(?:5[024568]|[24679])[\s\-]?\d{3}[\s\-]?\d{4}/g,  // UAE +971
    /00971[\s\-]?(?:5[024568]|[24679])[\s\-]?\d{3}[\s\-]?\d{4}/g,  // UAE 00971
    /05[024568][\s\-]?\d{3}[\s\-]?\d{4}/g,                          // UAE local 05X
    /\+961[\s\-]?\d{1,2}[\s\-]?\d{3}[\s\-]?\d{3,4}/g,              // Lebanon +961
    /\+1[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4}/g,              // USA +1
    /\+966[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{4}/g,                     // Saudi +966
    /\+\d{2,3}[\s\-]\d{2,4}[\s\-]\d{3,4}[\s\-]\d{3,4}/g,          // Generic intl with spaces
  ];
  const found = new Set();
  for (const p of patterns) {
    p.lastIndex = 0;
    for (const m of (text.match(p) || [])) {
      const v = validatePhone(m);
      if (v) found.add(v);
    }
  }
  return [...found];
}

// ─── Email validation ────────────────────────────────────────────────────────
const FAKE_EMAIL_DOMAINS = ['example.com','test.com','fake.com','domain.com','sample.com'];
const SPAM_PREFIXES = ['noreply','no-reply','donotreply','sentry','cloudflare','mailer-daemon','postmaster','abuse','bounce','notification','unsubscribe','privacy','legal','compliance'];
const SPAM_DOMAINS = ['sentry.io','ingest.sentry.io','cloudflare.com','amazonaws.com','googletagmanager.com','doubleclick.net','mailchimp.com','sendgrid.net','mandrill.com'];

// Personal email providers — never a company contact
const PERSONAL_EMAIL_DOMAINS = ['gmail.com','hotmail.com','yahoo.com','outlook.com','icloud.com','protonmail.com','live.com','msn.com','aol.com','mail.com','ymail.com'];

function validateEmail(e) {
  if (!e) return null;
  const em = e.toLowerCase().trim();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(em)) return null;
  if (FAKE_EMAIL_DOMAINS.some(d => em.endsWith(d))) return null;
  if (PERSONAL_EMAIL_DOMAINS.some(d => em.endsWith(d))) return null;
  if (SPAM_DOMAINS.some(d => em.includes(d))) return null;
  if (SPAM_PREFIXES.some(p => em.startsWith(p))) return null;
  const tld = em.split('.').pop();
  if (['test','example','local','invalid'].includes(tld)) return null;
  if (em.length < 6) return null;
  return em;
}

function extractEmails(text) {
  // Word boundary after TLD prevents matching "support@wsj.comfor" or "info@co.aecall"
  return (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,6}(?=[^a-zA-Z]|$)/g) || [])
    .map(validateEmail).filter(Boolean);
}

// ─── Lead classification ─────────────────────────────────────────────────────
const HIRER_KEYWORDS = [
  'sales executive','sales manager','sales director','head of sales',
  'vp sales','vp of sales','chief revenue','cro','revenue director',
  'business development','bdm','bdr','bd manager',
  'sdr','sales development','account executive','account manager',
  'key account','enterprise account','marketing manager','marketing director',
  'head of marketing','growth manager','demand generation','performance marketing',
  'digital marketing manager','commercial manager','commercial director',
  'partnerships manager','channel sales','regional sales','territory manager',
  'field sales','inside sales','outbound sales','pre-sales','presales',
  'solutions consultant','revenue manager',
];

const TALENT_SIGNALS = [
  'open to work','looking for','seeking a role','available for','job seeker',
  'actively looking','open for opportunities','seeking new opportunities',
  'available immediately','exploring opportunities','years in sales',
];

const HIRER_SIGNALS = [
  'we are hiring','we\'re hiring','now hiring','join our team',
  'we are looking for','open position','job opening','vacancy',
  'apply now','immediate opening','urgent requirement','looking to hire',
];

const EXCLUDE = [
  'software engineer','developer','devops','data scientist','machine learning',
  'frontend','backend','fullstack','accountant','financial analyst',
  'doctor','nurse','medical','driver','delivery','warehouse',
  'receptionist','hr manager','designer','graphic','ux designer',
  'content writer','copywriter','teacher',
];

const MARKETS = {
  UAE: ['dubai','abu dhabi','sharjah','uae','united arab emirates','ajman'],
  LEBANON: ['lebanon','beirut','jounieh','tripoli','sidon'],
  USA: ['united states','usa',' us ','new york','los angeles','chicago','san francisco','remote','austin','miami','boston','seattle'],
};

function detectLeadType(title, desc, postType) {
  const text = (title + ' ' + (desc || '')).toLowerCase();
  if (EXCLUDE.some(k => text.includes(k))) return null;
  if (!HIRER_KEYWORDS.some(k => text.includes(k))) return null;
  if (postType === 'job_board') return 'HIRER';
  const isTalent = TALENT_SIGNALS.some(s => text.includes(s));
  const isHirer = HIRER_SIGNALS.some(s => text.includes(s));
  if (isTalent && !isHirer) return 'TALENT';
  return 'HIRER';
}

function detectMarket(location) {
  const loc = (location || '').toLowerCase();
  for (const [m, kws] of Object.entries(MARKETS)) {
    if (kws.some(k => loc.includes(k))) return m;
  }
  return 'OTHER';
}

function scoreLead(lead) {
  let s = 0;
  const t = (lead.title || '').toLowerCase();
  if (/director|vp|head|chief/.test(t)) s += 35;
  else if (/manager|executive|lead/.test(t)) s += 25;
  else if (/sdr|bdr|development/.test(t)) s += 20;
  else s += 10;
  const h = (Date.now() - new Date(lead.postedAt || Date.now()).getTime()) / 3600000;
  if (h < 1) s += 50; else if (h < 6) s += 40; else if (h < 24) s += 25; else if (h < 72) s += 10;
  if (lead.contactPhone) s += 35;
  if (lead.contactEmail) s += 20;
  if (lead.market === 'UAE') s += 15;
  else if (lead.market === 'LEBANON') s += 12;
  else if (lead.market === 'USA') s += 10;
  if (lead.source === 'LinkedIn') s += 10;
  if (lead.source === 'Bayt') s += 8;
  if (lead.leadType === 'HIRER') s += 10;
  lead.score = s;
  lead.heat = s >= 70 ? 'Hot' : s >= 45 ? 'Warm' : 'Cold';
  return lead;
}

function generateMessage(lead) {
  const co = lead.company || 'your company';
  const role = lead.title || 'the role';
  const loc = lead.location || '';
  if (lead.leadType === 'HIRER') {
    const msgs = {
      Hot: `Hi — noticed ${co} is hiring a ${role}${loc ? ' in '+loc : ''}. We place pre-vetted Sales & Marketing talent in 72 hours at 10% of annual salary. Lebanese professionals — multilingual, commercially sharp, up to 50% more cost-effective than local hires. Worth a quick call this week?`,
      Warm: `Hi — saw ${co} is looking for a ${role}. Kinleague specialises in Sales & Marketing placement across UAE, Lebanon, and the US — pre-vetted shortlist in 72 hours, 10% fee. Happy to share how it works?`,
      Cold: `Hi — we help companies hire Sales and Marketing talent in 72 hours. Seeing ${co} is hiring — let me know if that could be useful.`,
    };
    return msgs[lead.heat] || msgs.Warm;
  }
  const msgs = {
    Hot: `Hi — your background in ${role} looks like a strong fit for roles we're filling right now in ${lead.market === 'UAE' ? 'Dubai' : lead.market === 'USA' ? 'the US' : 'the region'}. We're completely free for candidates and handle everything from intro to offer. Open to a quick call this week?`,
    Warm: `Hi — we place Sales & Marketing professionals in Dubai, the US, and Lebanon. Based on your profile, we may have relevant openings. No cost to you.`,
    Cold: `Hi — Kinleague places Sales talent in Dubai and the US. We're free for candidates. If open to new opportunities, we'd love to connect.`,
  };
  return msgs[lead.heat] || msgs.Warm;
}

// ─── Company domain finder ───────────────────────────────────────────────────
// Guesses the company's real website by trying common domain patterns,
// then falls back to a Google search for the company name.

async function findCompanyDomain(companyName, market) {
  // Clean company name for domain guessing
  const clean = companyName
    .toLowerCase()
    .replace(/\b(llc|ltd|inc|fze|fzc|corp|co\.|group|holding|holdings|intl|international|mena|uae|dubai|global)\b/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();

  if (!clean || clean.length < 3) return null;

  // Try most likely TLDs based on market
  const tlds = market === 'UAE' ? ['.ae', '.com'] :
               market === 'LEBANON' ? ['.com', '.lb'] :
               ['.com', '.io', '.co'];

  // Try common TLD patterns first
  for (const tld of tlds) {
    const domain = clean + tld;
    if (ALL_JOB_BOARD_DOMAINS.has(domain)) continue;
    try {
      await sleep(200);
      const { data } = await axios.get(`https://${domain}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        timeout: 4000, maxRedirects: 3,
      });
      // Validate: company name must appear on the page
      const pageText = cheerio.load(data).text().toLowerCase();
      const nameWords = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(w => w.length > 3);
      const matchCount = nameWords.filter(w => pageText.includes(w)).length;
      if (matchCount >= Math.min(2, nameWords.length)) return domain;
    } catch {}
  }

  // Google fallback — only use if result domain actually has company name on it
  try {
    await sleep(600);
    const q = encodeURIComponent(companyName + ' official site contact');
    const { data } = await axios.get(`https://www.google.com/search?q=${q}&num=5`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 6000,
    });
    const $ = cheerio.load(data);
    const GOOGLE_SKIP = new Set(['google.com','googleapis.com','gstatic.com','w3.org','schema.org','wikipedia.org','facebook.com','twitter.com','instagram.com']);
    const candidates = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const m = href.match(/https?:\/\/(www\.)?([a-z0-9\-\.]+\.[a-z]{2,})/i);
      if (m) {
        const host = m[2].toLowerCase();
        if (!ALL_JOB_BOARD_DOMAINS.has(host) && !GOOGLE_SKIP.has(host)) candidates.push(host);
      }
    });
    // Validate each candidate
    for (const domain of [...new Set(candidates)].slice(0, 3)) {
      try {
        await sleep(300);
        const { data: pageHtml } = await axios.get(`https://${domain}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 4000, maxRedirects: 3,
        });
        const pageText = cheerio.load(pageHtml).text().toLowerCase();
        const nameWords = companyName.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(' ').filter(w => w.length > 3);
        const matchCount = nameWords.filter(w => pageText.includes(w)).length;
        if (matchCount >= Math.min(2, nameWords.length)) return domain;
      } catch {}
    }
  } catch {}

  return null;
}

// ─── Contact enrichment ───────────────────────────────────────────────────────
// ALL job board / social / aggregator domains — never use these as company domains
const ALL_JOB_BOARD_DOMAINS = new Set([
  'linkedin.com','ae.linkedin.com','www.linkedin.com',
  'indeed.com','ae.indeed.com','lb.indeed.com','www.indeed.com',
  'glassdoor.com','www.glassdoor.com',
  'bayt.com','www.bayt.com',
  'naukrigulf.com','www.naukrigulf.com',
  'wuzzuf.net','www.wuzzuf.net',
  'remoteok.com','www.remoteok.com',
  'gulftalent.com','www.gulftalent.com',
  'ziprecruiter.com','www.ziprecruiter.com',
  'simplyhired.com','www.simplyhired.com',
  'wellfound.com','www.wellfound.com',
  'angel.co','www.angel.co',
  'google.com','www.google.com','jobs.google.com',
  'crunchbase.com','www.crunchbase.com',
]);
const SKIP_DOMAINS = ['linkedin.com','indeed.com','glassdoor.com'];
const JOB_BOARD_DOMAINS = ['bayt.com','naukrigulf.com','wuzzuf.net','remoteok.com','gulftalent.com','ziprecruiter.com','simplyhired.com','wellfound.com'];

async function fetchHTML(url, timeout = 8000) {
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout, maxRedirects: 5,
  });
  return data;
}

async function enrichContact(lead) {
  // 1. Try job page
  if (lead.link && lead.link !== '#' && !SKIP_DOMAINS.some(d => lead.link.includes(d))) {
    try {
      await sleep(400);
      const html = await fetchHTML(lead.link);
      const $ = cheerio.load(html);
      const text = $.text();
      if (!lead.contactPhone) { const p = extractPhones(text); if (p[0]) lead.contactPhone = p[0]; }
      if (!lead.contactEmail) { const e = extractEmails(text); if (e[0]) lead.contactEmail = e[0]; }
      if (!lead.contactName) {
        const nm = text.match(/(?:contact|apply to|hiring manager|recruiter)[\s:]+([A-Z][a-z]+ [A-Z][a-z]+)/i);
        if (nm) lead.contactName = nm[1];
      }
      // Also check JSON-LD on page
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const j = JSON.parse($(el).html());
          if (!lead.contactPhone && j.hiringOrganization?.telephone) {
            const v = validatePhone(j.hiringOrganization.telephone);
            if (v) lead.contactPhone = v;
          }
          if (!lead.contactEmail && j.hiringOrganization?.email) {
            const v = validateEmail(j.hiringOrganization.email);
            if (v) lead.contactEmail = v;
          }
        } catch {}
      });
      // Detect company domain from link — never use job board domains
      if (!lead.companyDomain) {
        try {
          const u = new URL(lead.link);
          const host = u.hostname.toLowerCase();
          if (!ALL_JOB_BOARD_DOMAINS.has(host) && !ALL_JOB_BOARD_DOMAINS.has(host.replace('www.',''))) {
            lead.companyDomain = host.replace('www.','');
          }
        } catch {}
      }
    } catch {}
  }

  // 2. Find company domain via Google if we don't have one yet
  if (!lead.companyDomain && lead.company) {
    lead.companyDomain = await findCompanyDomain(lead.company, lead.market);
  }

  // 3. Scrape company website for phone + email
  if ((!lead.contactPhone || !lead.contactEmail) && lead.companyDomain) {
    for (const page of ['/contact','/contact-us','/about','/about-us','']) {
      try {
        await sleep(300);
        const html = await fetchHTML(`https://${lead.companyDomain}${page}`, 7000);
        const text = cheerio.load(html).text();
        if (!lead.contactPhone) { const p = extractPhones(text); if (p[0]) lead.contactPhone = p[0]; }
        if (!lead.contactEmail) { const e = extractEmails(text); if (e[0]) lead.contactEmail = e[0]; }
        if (lead.contactPhone && lead.contactEmail) break;
      } catch {}
    }
  }

  // 4. Probable emails fallback — only for real company domains (not job boards)
  if (!lead.contactEmail && lead.companyDomain && !ALL_JOB_BOARD_DOMAINS.has(lead.companyDomain)) {
    lead.probableEmails = [
      `hiring@${lead.companyDomain}`,
      `hr@${lead.companyDomain}`,
      `careers@${lead.companyDomain}`,
      `hello@${lead.companyDomain}`,
    ];
  }
  return lead;
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────
const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
];
const ua = () => UAS[Math.floor(Math.random() * UAS.length)];
const ax = (extra = {}) => ({ headers: { 'User-Agent': ua(), 'Accept-Language': 'en-US,en;q=0.9', ...extra.headers }, timeout: 15000, ...extra });
const mkId = (pfx, ...parts) => pfx + Buffer.from(parts.join('')).toString('base64').slice(0, 14);

async function scrapeLinkedInJobs(url, market) {
  try {
    await sleep(1000 + Math.random()*1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('.base-card').each((_, el) => {
      const title    = $(el).find('.base-search-card__title').text().trim();
      const company  = $(el).find('.base-search-card__subtitle').text().trim();
      const location = $(el).find('.job-search-card__location').text().trim();
      const time     = $(el).find('time').attr('datetime') || new Date().toISOString();
      const link     = ($(el).find('a.base-card__full-link,a').first().attr('href') || '').split('?')[0];
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('li_', company, title, time), title, company, location, market: market || detectMarket(location), postedAt: time, link, source: 'LinkedIn', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('LinkedIn:', e.message); return []; }
}

async function scrapeIndeed(url, market) {
  try {
    await sleep(1000 + Math.random()*1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('[data-jk]').each((_, el) => {
      const title    = $(el).find('[class*="jobTitle"]').text().trim();
      const company  = $(el).find('[data-testid="company-name"]').text().trim();
      const location = $(el).find('[data-testid="text-location"]').text().trim();
      const jk       = $(el).attr('data-jk');
      if (!title || !company || !jk) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      const base = url.includes('ae.indeed') ? 'https://ae.indeed.com' : url.includes('lb.') ? 'https://lb.indeed.com' : 'https://www.indeed.com';
      leads.push({ id: 'ind_'+jk, title, company, location, market: market || detectMarket(location), postedAt: new Date().toISOString(), link: `${base}/viewjob?jk=${jk}`, source: 'Indeed', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('Indeed:', e.message); return []; }
}

async function scrapeBayt(url, market) {
  try {
    await sleep(1000 + Math.random()*1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('[data-job-id], .has-pointer-d').each((_, el) => {
      const title    = $(el).find('h2 a,[class*="title"] a').first().text().trim();
      const company  = $(el).find('[class*="company"],[class*="jb-company"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || market || 'UAE';
      const href     = $(el).find('a').first().attr('href') || '';
      const link     = href.startsWith('http') ? href : 'https://www.bayt.com' + href;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('bt_', company, title), title, company, location, market: market || detectMarket(location), postedAt: new Date().toISOString(), link, source: 'Bayt', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('Bayt:', e.message); return []; }
}

async function scrapeNaukriGulf(url, market) {
  try {
    await sleep(1000 + Math.random()*1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('[class*="job-listing"],[class*="jobListing"],li[data-id],.ni-job-tuple').each((_, el) => {
      const title    = $(el).find('a[class*="title"],h2 a,h3 a,.title').first().text().trim();
      const company  = $(el).find('[class*="company"],[class*="employer"],.company').first().text().trim();
      const location = $(el).find('[class*="location"],.location').first().text().trim() || 'UAE';
      const href     = $(el).find('a').first().attr('href') || '';
      const link     = href.startsWith('http') ? href : 'https://www.naukrigulf.com' + href;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('ng_', company, title), title, company, location, market: market || 'UAE', postedAt: new Date().toISOString(), link, source: 'NaukriGulf', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('NaukriGulf:', e.message); return []; }
}

async function scrapeGlassdoor(url, market) {
  try {
    await sleep(1500 + Math.random()*1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('[data-test="jobListing"],[class*="JobsList_jobListItem"],[class*="react-job-listing"]').each((_, el) => {
      const title    = $(el).find('[data-test="job-title"],[class*="JobCard_jobTitle"],.job-title').first().text().trim();
      const company  = $(el).find('[data-test="employer-name"],[class*="JobCard_employer"]').first().text().trim();
      const location = $(el).find('[data-test="emp-location"],[class*="JobCard_location"]').first().text().trim() || market;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('gd_', company, title), title, company, location, market: market || detectMarket(location), postedAt: new Date().toISOString(), link: url, source: 'Glassdoor', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('Glassdoor:', e.message); return []; }
}

async function scrapeWuzzuf(url) {
  try {
    await sleep(1000 + Math.random()*1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('article[data-jobid],[class*="job-card"],.wuzf-job').each((_, el) => {
      const title    = $(el).find('h2 a,h3 a,[class*="title"] a').first().text().trim();
      const company  = $(el).find('[class*="company"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || 'MENA';
      const href     = $(el).find('a').first().attr('href') || '';
      const link     = href.startsWith('http') ? href : 'https://wuzzuf.net' + href;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('wz_', company, title), title, company, location, market: detectMarket(location), postedAt: new Date().toISOString(), link, source: 'Wuzzuf', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('Wuzzuf:', e.message); return []; }
}

async function scrapeRemoteOK() {
  try {
    const { data } = await axios.get('https://remoteok.com/remote-sales-jobs.json', ax({ headers: { Accept: 'application/json' } }));
    if (!Array.isArray(data)) return [];
    return data.filter(j => j && j.position && detectLeadType(j.position, j.description || '', 'job_board')).map(j => ({
      id: 'rok_' + j.id,
      title: j.position, company: j.company || '',
      location: j.location || 'Remote', market: 'USA',
      postedAt: j.date || new Date().toISOString(),
      link: j.url || `https://remoteok.com/remote-jobs/${j.id}`,
      source: 'RemoteOK', leadType: 'HIRER',
      contactEmail: validateEmail(j.email) || undefined,
      scrapedAt: new Date().toISOString(),
    }));
  } catch (e) { console.error('RemoteOK:', e.message); return []; }
}

async function scrapeGulfTalent(url, market) {
  try {
    await sleep(1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('[class*="job"],article').each((_, el) => {
      const title    = $(el).find('h2 a,h3 a,[class*="title"]').first().text().trim();
      const company  = $(el).find('[class*="company"],[class*="employer"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || market;
      const href     = $(el).find('a').first().attr('href') || '';
      const link     = href.startsWith('http') ? href : 'https://www.gulftalent.com' + href;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('gt_', company, title), title, company, location, market: market || 'UAE', postedAt: new Date().toISOString(), link, source: 'GulfTalent', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('GulfTalent:', e.message); return []; }
}

async function scrapeZipRecruiter(url) {
  try {
    await sleep(1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('[data-job-id],article[class*="job"]').each((_, el) => {
      const title    = $(el).find('[class*="job_title"],h2').first().text().trim();
      const company  = $(el).find('[class*="hiring_company"],[class*="company"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || 'Remote';
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('zr_', company, title), title, company, location, market: 'USA', postedAt: new Date().toISOString(), link: url, source: 'ZipRecruiter', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('ZipRecruiter:', e.message); return []; }
}

async function scrapeSimplyHired(url) {
  try {
    await sleep(1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('[data-jobkey],[class*="SerpJob"]').each((_, el) => {
      const title    = $(el).find('h2 a,[class*="title"]').first().text().trim();
      const company  = $(el).find('[class*="company"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || 'USA';
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('sh_', company, title), title, company, location, market: 'USA', postedAt: new Date().toISOString(), link: url, source: 'SimplyHired', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('SimplyHired:', e.message); return []; }
}

async function scrapeWellfound(url) {
  try {
    await sleep(1000);
    const { data } = await axios.get(url, ax());
    const $ = cheerio.load(data);
    const leads = [];
    $('[class*="StartupResult"],[class*="job-listing"]').each((_, el) => {
      const title    = $(el).find('h2,[class*="title"]').first().text().trim();
      const company  = $(el).find('[class*="startup"],[class*="company"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || 'Remote';
      const href     = $(el).find('a').first().attr('href') || '';
      const link     = href.startsWith('http') ? href : 'https://wellfound.com' + href;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('wf_', company, title), title, company, location, market: detectMarket(location), postedAt: new Date().toISOString(), link, source: 'Wellfound', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('Wellfound:', e.message); return []; }
}

async function scrapeGoogleJobs(query, market) {
  try {
    await sleep(1500 + Math.random()*1000);
    const { data } = await axios.get(
      `https://www.google.com/search?q=${encodeURIComponent(query + ' job')}&ibp=htl;jobs`,
      ax()
    );
    const $ = cheerio.load(data);
    const leads = [];
    // JSON-LD structured data (most reliable on Google Jobs)
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const jobs = [].concat(JSON.parse($(el).html()));
        jobs.forEach(j => {
          if (j['@type'] !== 'JobPosting') return;
          const title = j.title || '';
          const company = j.hiringOrganization?.name || '';
          const location = j.jobLocation?.address?.addressLocality || market;
          if (!title || !company) return;
          const type = detectLeadType(title, j.description || '', 'job_board');
          if (!type) return;
          leads.push({
            id: mkId('gj_', company, title),
            title, company, location,
            market: market || detectMarket(location),
            postedAt: j.datePosted || new Date().toISOString(),
            link: j.url || j.mainEntityOfPage || '',
            source: 'Google Jobs', leadType: type,
            contactEmail: validateEmail(j.hiringOrganization?.email) || undefined,
            contactPhone: validatePhone(j.hiringOrganization?.telephone) || undefined,
            scrapedAt: new Date().toISOString(),
          });
        });
      } catch {}
    });
    // DOM fallback
    $('div[role="treeitem"]').each((_, el) => {
      const title    = $(el).find('[class*="title"],h2,h3').first().text().trim();
      const company  = $(el).find('[class*="company"],[class*="subtitle"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || market;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: mkId('gj_', company, title), title, company, location, market: market || detectMarket(location), postedAt: new Date().toISOString(), link: `https://www.google.com/search?q=${encodeURIComponent(title+' '+company+' apply')}`, source: 'Google Jobs', leadType: type, scrapedAt: new Date().toISOString() });
    });
    return leads;
  } catch (e) { console.error('Google Jobs:', e.message); return []; }
}

// Demo fallback — used ONLY when ALL scrapers return 0 results
function getDemoLeads() {
  const t = () => new Date(Date.now() - Math.random()*86400000*3).toISOString();
  return [
    { title:'Head of Sales', company:'Noon.com', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'VP of Sales', company:'Careem', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'Sales Director', company:'Talabat', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'Business Development Manager', company:'Property Finder', location:'Dubai, UAE', source:'Indeed', market:'UAE', leadType:'HIRER' },
    { title:'Enterprise Sales Manager', company:'Salesforce UAE', location:'Dubai, UAE', source:'Glassdoor', market:'UAE', leadType:'HIRER' },
    { title:'Sales Executive', company:'Anghami', location:'Beirut, Lebanon', source:'LinkedIn', market:'LEBANON', leadType:'HIRER' },
    { title:'Growth Manager', company:'Kitopi', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'Account Executive', company:'HubSpot MENA', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'Sales Manager', company:'Emaar Properties', location:'Dubai, UAE', source:'Bayt', market:'UAE', leadType:'HIRER' },
    { title:'Regional Sales Manager', company:'Aramex', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'Account Executive', company:'Salesforce', location:'New York, USA', source:'RemoteOK', market:'USA', leadType:'HIRER' },
    { title:'SDR Team Lead', company:'HubSpot', location:'Remote, USA', source:'RemoteOK', market:'USA', leadType:'HIRER' },
    { title:'VP Sales', company:'Stripe', location:'San Francisco, USA', source:'LinkedIn', market:'USA', leadType:'HIRER' },
    { title:'Marketing Manager', company:'Dubizzle', location:'Dubai, UAE', source:'Bayt', market:'UAE', leadType:'HIRER' },
    { title:'BDM - SaaS', company:'Wamda', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'Sales Manager', company:'EDLY', location:'Beirut, Lebanon', source:'Bayt', market:'LEBANON', leadType:'HIRER' },
    { title:'Head of Growth', company:'Sarwa', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'Sales Development Rep', company:'Deel', location:'Remote', source:'Wellfound', market:'USA', leadType:'HIRER' },
    { title:'Commercial Director', company:'Majid Al Futtaim', location:'Dubai, UAE', source:'LinkedIn', market:'UAE', leadType:'HIRER' },
    { title:'Key Account Manager', company:'PepsiCo MENA', location:'Dubai, UAE', source:'Indeed', market:'UAE', leadType:'HIRER' },
  ].map((l,i) => ({
    ...l,
    id: mkId('demo_', l.company, l.title),
    postedAt: new Date(Date.now() - i*3600000*2).toISOString(),
    scrapedAt: new Date().toISOString(),
  }));
}

// ─── Source batches ───────────────────────────────────────────────────────────
const ROUND1 = [
  { fn: scrapeLinkedInJobs, args: ['https://www.linkedin.com/jobs/search/?keywords=sales+executive&location=Dubai&f_TPR=r3600&sortBy=DD', 'UAE'], label: 'LinkedIn Dubai (1h)' },
  { fn: scrapeLinkedInJobs, args: ['https://www.linkedin.com/jobs/search/?keywords=SDR+BDR+business+development&location=UAE&f_TPR=r3600&sortBy=DD', 'UAE'], label: 'LinkedIn UAE BDR (1h)' },
  { fn: scrapeLinkedInJobs, args: ['https://www.linkedin.com/jobs/search/?keywords=account+executive+sales+manager&location=United+States&f_WT=2&f_TPR=r3600&sortBy=DD', 'USA'], label: 'LinkedIn USA Remote (1h)' },
  { fn: scrapeIndeed, args: ['https://ae.indeed.com/jobs?q=sales+executive+marketing&fromage=1&sort=date', 'UAE'], label: 'Indeed UAE (today)' },
  { fn: scrapeIndeed, args: ['https://www.indeed.com/jobs?q=account+executive+SDR&l=remote&fromage=1&sort=date', 'USA'], label: 'Indeed USA Remote (today)' },
  { fn: scrapeBayt, args: ['https://www.bayt.com/en/uae/jobs/sales-executive-jobs/', 'UAE'], label: 'Bayt UAE Sales' },
  { fn: scrapeNaukriGulf, args: ['https://www.naukrigulf.com/sales-jobs-in-uae', 'UAE'], label: 'NaukriGulf UAE' },
  { fn: scrapeRemoteOK, args: [], label: 'RemoteOK' },
];

const ROUND2 = [
  { fn: scrapeLinkedInJobs, args: ['https://www.linkedin.com/jobs/search/?keywords=marketing+manager+growth&location=UAE&f_TPR=r86400', 'UAE'], label: 'LinkedIn UAE Marketing' },
  { fn: scrapeLinkedInJobs, args: ['https://www.linkedin.com/jobs/search/?keywords=sales+marketing&location=Lebanon&f_TPR=r604800', 'LEBANON'], label: 'LinkedIn Lebanon' },
  { fn: scrapeLinkedInJobs, args: ['https://www.linkedin.com/jobs/search/?keywords=head+of+sales+revenue+director&location=USA&f_TPR=r86400', 'USA'], label: 'LinkedIn USA Leadership' },
  { fn: scrapeIndeed, args: ['https://lb.indeed.com/jobs?q=sales+marketing&fromage=14&sort=date', 'LEBANON'], label: 'Indeed Lebanon' },
  { fn: scrapeIndeed, args: ['https://www.indeed.com/jobs?q=sales+director+VP+sales&fromage=3', 'USA'], label: 'Indeed USA Leadership' },
  { fn: scrapeBayt, args: ['https://www.bayt.com/en/uae/jobs/business-development-manager-jobs/', 'UAE'], label: 'Bayt UAE BDM' },
  { fn: scrapeBayt, args: ['https://www.bayt.com/en/uae/jobs/marketing-manager-jobs/', 'UAE'], label: 'Bayt UAE Marketing' },
  { fn: scrapeBayt, args: ['https://www.bayt.com/en/lebanon/jobs/sales-manager-jobs/', 'LEBANON'], label: 'Bayt Lebanon' },
  { fn: scrapeNaukriGulf, args: ['https://www.naukrigulf.com/marketing-jobs-in-uae', 'UAE'], label: 'NaukriGulf Marketing' },
  { fn: scrapeGlassdoor, args: ['https://www.glassdoor.com/Job/dubai-sales-jobs-SRCH_IL.0,5_IC2204498_KO6,11.htm', 'UAE'], label: 'Glassdoor Dubai' },
  { fn: scrapeWuzzuf, args: ['https://wuzzuf.net/search/jobs/?q=sales+marketing&a=hpb&l=Lebanon'], label: 'Wuzzuf Lebanon' },
  { fn: scrapeWellfound, args: ['https://wellfound.com/jobs?role=Sales&location=Dubai'], label: 'Wellfound Dubai' },
  { fn: scrapeWellfound, args: ['https://wellfound.com/jobs?role=Sales&remote=true'], label: 'Wellfound Remote' },
  { fn: scrapeGulfTalent, args: ['https://www.gulftalent.com/jobs/sales-jobs', 'UAE'], label: 'GulfTalent Sales' },
  { fn: scrapeGulfTalent, args: ['https://www.gulftalent.com/jobs/marketing-jobs', 'UAE'], label: 'GulfTalent Marketing' },
];

const ROUND3 = [
  { fn: scrapeGoogleJobs, args: ['sales executive Dubai', 'UAE'], label: 'Google Jobs Dubai' },
  { fn: scrapeGoogleJobs, args: ['SDR sales development representative remote', 'USA'], label: 'Google Jobs USA SDR' },
  { fn: scrapeGoogleJobs, args: ['sales manager Lebanon Beirut', 'LEBANON'], label: 'Google Jobs Lebanon' },
  { fn: scrapeGoogleJobs, args: ['business development manager UAE', 'UAE'], label: 'Google Jobs UAE BDM' },
  { fn: scrapeLinkedInJobs, args: ['https://www.linkedin.com/jobs/search/?keywords=sales+executive+marketing&location=Saudi+Arabia&f_TPR=r86400', 'UAE'], label: 'LinkedIn Saudi (as MENA proxy)' },
  { fn: scrapeZipRecruiter, args: ['https://www.ziprecruiter.com/Jobs/Sales-Executive?l=remote', 'USA'], label: 'ZipRecruiter Remote' },
  { fn: scrapeSimplyHired, args: ['https://www.simplyhired.com/search?q=account+executive&l=remote', 'USA'], label: 'SimplyHired USA' },
];

// ─── CRM push ─────────────────────────────────────────────────────────────────
async function pushToCRM(lead) {
  try {
    const payload = {
      name: lead.leadType === 'HIRER' ? (lead.company || lead.title) : (lead.contactName || lead.title || 'Sales Professional'),
      email: lead.contactEmail || lead.probableEmails?.[0] || '',
      enquiry_type: lead.leadType === 'HIRER' ? 'hire' : 'talent',
      role: lead.title || '',
      message: [
        `LEAD TYPE: ${lead.leadType} | HEAT: ${lead.heat} | SCORE: ${lead.score}`,
        `MARKET: ${lead.market} | SOURCE: ${lead.source}`,
        `LOCATION: ${lead.location || ''}`,
        `POSTED: ${lead.postedAt} | SCRAPED: ${lead.scrapedAt}`,
        `LINK: ${lead.link || ''}`,
        lead.contactPhone ? `PHONE: ${lead.contactPhone}` : '',
        lead.contactEmail ? `EMAIL: ${lead.contactEmail}` : '',
        lead.probableEmails?.length ? `PROBABLE EMAILS: ${lead.probableEmails.join(', ')}` : '',
        '',
        'OUTREACH:',
        lead.message || '',
      ].filter(Boolean).join('\n'),
      source: 'lead_engine_auto',
      created_at: new Date().toISOString(),
    };
    const r = await axios.post(`${CRM_URL}/rest/v1/website_leads`, payload, {
      headers: { 'Content-Type': 'application/json', apikey: CRM_KEY, Authorization: `Bearer ${CRM_KEY}`, Prefer: 'return=minimal' },
      timeout: 10000,
    });
    return r.status === 201 || r.status === 200;
  } catch (e) { console.error('CRM push failed:', e.message); return false; }
}

// Strip phones/emails that appear on 3+ different companies — definitely a shared scraping artifact
function stripSharedContacts(leads) {
  const phoneCounts = {};
  const emailCounts = {};
  leads.forEach(l => {
    if (l.contactPhone) phoneCounts[l.contactPhone] = (phoneCounts[l.contactPhone] || 0) + 1;
    if (l.contactEmail) emailCounts[l.contactEmail] = (emailCounts[l.contactEmail] || 0) + 1;
  });
  let stripped = 0;
  leads.forEach(l => {
    if (l.contactPhone && phoneCounts[l.contactPhone] >= 3) { delete l.contactPhone; stripped++; }
    if (l.contactEmail && emailCounts[l.contactEmail] >= 3) { delete l.contactEmail; stripped++; }
  });
  if (stripped > 0) console.log(`Stripped ${stripped} shared/artifact contacts`);
  return leads;
}

function saveCsv(leads) {
  const hdr = 'ID,Type,Company,Role,Location,Market,Source,Heat,Score,Phone,Email,Posted,Link';
  const rows = leads.map(l =>
    [l.id,l.leadType,l.company,l.title,l.location,l.market,l.source,l.heat,l.score,
     l.contactPhone||'',l.contactEmail||'',l.postedAt,l.link]
    .map(v => `"${String(v||'').replace(/"/g,"'")}"`)
    .join(',')
  );
  fs.writeFileSync(path.join(DATA_DIR, 'leads.csv'), [hdr,...rows].join('\n'));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function runScrapeAndPush() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] ═══ Lead Engine ═══`);

  // Load + clean existing
  const existing = loadLeads();
  const cleanedExisting = cleanDuplicates(existing);
  if (cleanedExisting.length < existing.length) {
    saveLeads(cleanedExisting);
    console.log(`Cleaned ${existing.length - cleanedExisting.length} duplicate existing leads`);
  }

  const dedupIdx = loadDedup();
  // Rebuild dedup index from existing if empty
  if (dedupIdx.size === 0 && cleanedExisting.length > 0) {
    cleanedExisting.forEach(l => dedupIdx.add(makeDedupKey(l)));
    saveDedup(dedupIdx);
    console.log(`Built dedup index: ${dedupIdx.size} keys`);
  }

  const pushedIds = loadPushed();
  let allNew = [];
  let usedDemo = false;

  // ── Scrape rounds until MIN_NEW_LEADS met ────────────────────────────────
  for (const [round, sources] of [[1,ROUND1],[2,ROUND2],[3,ROUND3]]) {
    if (allNew.length >= MIN_NEW_LEADS) break;
    const need = MIN_NEW_LEADS - allNew.length;
    console.log(`\nRound ${round} — need ${need} more new leads`);

    let roundRaw = [];
    for (const src of sources) {
      try {
        process.stdout.write(`  ${src.label}... `);
        const r = await src.fn(...(src.args||[]));
        console.log(`${r.length}`);
        roundRaw = [...roundRaw, ...r];
      } catch (e) { console.log(`ERR: ${e.message}`); }
      await sleep(500);
    }

    const newFromRound = filterNew([...cleanedExisting,...allNew], roundRaw, dedupIdx);
    console.log(`Round ${round} result: ${newFromRound.length} genuinely new`);
    allNew = [...allNew, ...newFromRound];
  }

  // Demo fallback only when ALL scrapers return nothing
  if (allNew.length === 0) {
    console.log('All scrapers returned 0 results — using demo leads');
    const demos = getDemoLeads();
    allNew = filterNew(cleanedExisting, demos, dedupIdx);
    usedDemo = true;
  }

  console.log(`\nTotal new leads this run: ${allNew.length}`);

  // ── Enrich ────────────────────────────────────────────────────────────────
  console.log(`Enriching up to ${Math.min(allNew.length, MAX_ENRICH)} leads...`);
  const enriched = [];
  for (let i = 0; i < Math.min(allNew.length, MAX_ENRICH); i++) {
    process.stdout.write(`  ${i+1}/${Math.min(allNew.length,MAX_ENRICH)}: ${allNew[i].company}\r`);
    enriched.push(await enrichContact(allNew[i]));
    await sleep(200);
  }
  console.log('');
  const unenriched = allNew.slice(MAX_ENRICH);
  const allProcessed = [...enriched, ...unenriched];

  // ── Score ─────────────────────────────────────────────────────────────────
  const scored = allProcessed.map(l => { const s = scoreLead(l); s.message = generateMessage(s); return s; });

  // ── Merge + final dedup + strip artifacts + sort + cap ────────────────────
  const merged = stripSharedContacts(
    cleanDuplicates([...scored, ...cleanedExisting])
  )
    .sort((a,b) => { const h={Hot:0,Warm:1,Cold:2}; return h[a.heat]!==h[b.heat] ? h[a.heat]-h[b.heat] : (b.score||0)-(a.score||0); })
    .slice(0, MAX_TOTAL);

  // ── Save ──────────────────────────────────────────────────────────────────
  const saved = saveLeads(merged);
  if (saved) { saveDedup(dedupIdx); saveCsv(merged); }

  // ── Auto-push hot leads ───────────────────────────────────────────────────
  const toPush = scored.filter(l => l.heat === 'Hot' && !pushedIds.has(l.id) && (l.contactEmail || l.contactPhone || l.probableEmails?.length));
  const warmPush = scored.filter(l => l.heat === 'Warm' && !pushedIds.has(l.id) && l.contactEmail).slice(0, 10);
  let pushCount = 0;
  for (const lead of [...toPush, ...warmPush]) {
    if (await pushToCRM(lead)) { pushedIds.add(lead.id); pushCount++; console.log(`  ✓ ${lead.company}`); }
    await sleep(300);
  }
  savePushed(pushedIds);

  // ── State ─────────────────────────────────────────────────────────────────
  const state = {
    lastRun: new Date().toISOString(),
    totalLeads: merged.length,
    newThisRun: scored.length,
    hotLeads: merged.filter(l=>l.heat==='Hot').length,
    warmLeads: merged.filter(l=>l.heat==='Warm').length,
    withPhone: merged.filter(l=>l.contactPhone).length,
    withEmail: merged.filter(l=>l.contactEmail).length,
    withContact: merged.filter(l=>l.contactPhone||l.contactEmail).length,
    hirers: merged.filter(l=>l.leadType==='HIRER').length,
    talent: merged.filter(l=>l.leadType==='TALENT').length,
    uae: merged.filter(l=>l.market==='UAE').length,
    usa: merged.filter(l=>l.market==='USA').length,
    lebanon: merged.filter(l=>l.market==='LEBANON').length,
    pushedThisRun: pushCount,
    totalPushed: pushedIds.size,
    minLeadsGuarantee: allNew.length >= MIN_NEW_LEADS ? 'MET' : `PARTIAL (${allNew.length})`,
    usedDemo,
    durationMs: Date.now() - t0,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`\n═══ DONE ${(state.durationMs/1000).toFixed(1)}s ═══`);
  console.log(`Total: ${merged.length} | New: ${scored.length} | Guarantee: ${state.minLeadsGuarantee}`);
  console.log(`Hirers: ${state.hirers} | Talent: ${state.talent}`);
  console.log(`Hot: ${state.hotLeads} | Phone: ${state.withPhone} | Email: ${state.withEmail} | Pushed: ${pushCount}`);
  return state;
}

module.exports = { runScrapeAndPush };
if (require.main === module) runScrapeAndPush().catch(console.error);
