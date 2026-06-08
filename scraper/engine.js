'use strict';
/**
 * Kinleague Lead Engine — 14 free public sources
 * Runs every minute via GitHub Actions cron
 * Export: run()
 */

const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const DEDUP_FILE = path.join(DATA_DIR, 'dedup.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  },
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  maxRedirects: 5,
});

// ─── SCORING ─────────────────────────────────────────────────────────────────
const HOT_KEYWORDS = [
  'head of sales','vp sales','vp of sales','chief sales','sales director',
  'director of sales','revenue director','chief revenue','cro',
  'vp marketing','chief marketing','cmo','head of marketing',
  'sales manager','bd manager','business development manager',
  'account executive','growth manager','enterprise sales',
];
const WARM_KEYWORDS = [
  'sales','business development','bd','account manager','marketing manager',
  'growth','revenue','customer success','commercial','territory',
];
const PHONE_RE = /(?:\+?(?:971|961|1|44)\s?)?(?:\(?\d{2,4}\)?[\s\-]?){2,4}\d{3,4}/;
const WA_RE = /whatsapp|wa\.me/i;

function scoreAndNormalize(raw) {
  const title = (raw.title || '').toLowerCase();
  const body  = (raw.body  || '').toLowerCase();
  const text  = title + ' ' + body;

  let heat = 'Cold';
  if (HOT_KEYWORDS.some(k => text.includes(k)))  heat = 'Hot';
  else if (WARM_KEYWORDS.some(k => text.includes(k))) heat = 'Warm';

  const isHirer = /hir|recruit|looking for|we need|opening|vacancy|position available/i.test(text);
  const isTalent= /seeking|available|open to work|looking for.*role|my experience|years.*experience/i.test(text);
  const leadType = isHirer ? 'HIRER' : isTalent ? 'TALENT' : 'HIRER';

  const phoneMatch = text.match(PHONE_RE);
  const phone = phoneMatch ? phoneMatch[0].trim() : null;
  const whatsapp = WA_RE.test(text) ? (raw.link || null) : null;

  const id = [raw.source, raw.company, raw.title]
    .join('|').replace(/\s+/g,'_').toLowerCase().replace(/[^a-z0-9_|]/g,'').slice(0,80);

  return {
    id,
    title:     raw.title || 'Untitled',
    company:   raw.company || 'Unknown',
    location:  raw.location || '',
    market:    /lebanon|beirut|lb/i.test(raw.location || '') ? 'LB' : 'UAE',
    source:    raw.source || 'Unknown',
    link:      raw.link || '',
    postedAt:  raw.postedAt || new Date().toISOString(),
    heat,
    leadType,
    phone,
    whatsapp,
    email:     raw.email || null,
    body:      (raw.body || '').slice(0, 400),
    scrapedAt: new Date().toISOString(),
  };
}

// ─── DEDUP ────────────────────────────────────────────────────────────────────
function loadDedup() {
  try { return new Set(JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8'))); } catch { return new Set(); }
}
function saveDedup(set) {
  const arr = [...set].slice(-5000);
  fs.writeFileSync(DEDUP_FILE, JSON.stringify(arr));
}
function dedupKey(lead) {
  return [lead.source, lead.company, lead.title].join('|').toLowerCase().replace(/\s+/g,'_');
}

// ─── SOURCES ─────────────────────────────────────────────────────────────────

async function scrapeOpenSooqUAE() {
  const leads = [];
  try {
    const r = await http.get('https://uae.opensooq.com/search?term=sales+manager&category_id=&subcategory_id=&searchType=1');
    const $ = cheerio.load(r.data);
    $('li.u-list-item, .listing-item, .post-listing').each((_, el) => {
      const title   = $(el).find('.listing-post-title, h2, .title').first().text().trim();
      const company = $(el).find('.username, .seller-name').first().text().trim();
      const loc     = $(el).find('.listing-location, .location').first().text().trim() || 'UAE';
      const link    = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'OpenSooq UAE', link: link.startsWith('http')?link:'https://uae.opensooq.com'+link });
    });
  } catch (e) { console.error('[OpenSooq UAE]', e.message); }
  return leads;
}

async function scrapeOpenSooqLB() {
  const leads = [];
  try {
    const r = await http.get('https://lb.opensooq.com/search?term=sales&category_id=&subcategory_id=&searchType=1');
    const $ = cheerio.load(r.data);
    $('li.u-list-item, .listing-item, .post-listing').each((_, el) => {
      const title   = $(el).find('.listing-post-title, h2, .title').first().text().trim();
      const company = $(el).find('.username, .seller-name').first().text().trim();
      const loc     = $(el).find('.listing-location, .location').first().text().trim() || 'Beirut, Lebanon';
      const link    = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'OpenSooq Lebanon', link: link.startsWith('http')?link:'https://lb.opensooq.com'+link });
    });
  } catch (e) { console.error('[OpenSooq Lebanon]', e.message); }
  return leads;
}

async function scrapeDubizzle() {
  const leads = [];
  try {
    const r = await http.get('https://dubai.dubizzle.com/jobs/sales/?keywords=sales+manager');
    const $ = cheerio.load(r.data);
    $('article, .listing-card, [class*="listingCard"], [class*="JobCard"]').each((_, el) => {
      const title   = $(el).find('h2, h3, [class*="title"]').first().text().trim();
      const company = $(el).find('[class*="company"], [class*="employer"]').first().text().trim();
      const loc     = $(el).find('[class*="location"]').first().text().trim() || 'Dubai, UAE';
      const link    = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'Dubizzle UAE', link: link.startsWith('http')?link:'https://dubai.dubizzle.com'+link });
    });
  } catch (e) { console.error('[Dubizzle]', e.message); }
  return leads;
}

async function scrapeOLXLebanon() {
  const leads = [];
  try {
    const r = await http.get('https://www.olx.com.lb/jobs/c-20?q=sales');
    const $ = cheerio.load(r.data);
    $('li[data-aut-id="itemBox"], .EIR5N').each((_, el) => {
      const title = $(el).find('[data-aut-id="itemTitle"], ._1uofc').first().text().trim();
      const loc   = $(el).find('[data-aut-id="item-location"], .tjgMj').first().text().trim() || 'Lebanon';
      const link  = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company:'Employer', location: loc, source:'OLX Lebanon', link: link.startsWith('http')?link:'https://www.olx.com.lb'+link });
    });
  } catch (e) { console.error('[OLX Lebanon]', e.message); }
  return leads;
}

async function scrapeExpatriatesUAE() {
  const leads = [];
  try {
    const r = await http.get('https://www.expatriates.com/classifieds/uae/jobs/');
    const $ = cheerio.load(r.data);
    $('table.classifiedsList tr, .classified-listing').each((_, el) => {
      const title = $(el).find('a.ad-title, td.subject a').first().text().trim();
      const loc   = $(el).find('.location').first().text().trim() || 'UAE';
      const link  = $(el).find('a.ad-title, td.subject a').first().attr('href') || '';
      if (title && title.length > 3) leads.push({ title, company:'Employer', location: loc, source:'Expatriates UAE', link: link.startsWith('http')?link:'https://www.expatriates.com'+link });
    });
  } catch (e) { console.error('[Expatriates UAE]', e.message); }
  return leads;
}

async function scrapeExpatriatesLB() {
  const leads = [];
  try {
    const r = await http.get('https://www.expatriates.com/classifieds/lebanon/jobs/');
    const $ = cheerio.load(r.data);
    $('table.classifiedsList tr, .classified-listing').each((_, el) => {
      const title = $(el).find('a.ad-title, td.subject a').first().text().trim();
      const loc   = $(el).find('.location').first().text().trim() || 'Lebanon';
      const link  = $(el).find('a.ad-title, td.subject a').first().attr('href') || '';
      if (title && title.length > 3) leads.push({ title, company:'Employer', location: loc, source:'Expatriates Lebanon', link: link.startsWith('http')?link:'https://www.expatriates.com'+link });
    });
  } catch (e) { console.error('[Expatriates Lebanon]', e.message); }
  return leads;
}

async function scrapeIndeedUAE() {
  const leads = [];
  try {
    const r = await http.get('https://ae.indeed.com/jobs?q=sales+manager&l=Dubai&sort=date&fromage=1');
    const $ = cheerio.load(r.data);
    $('div.job_seen_beacon, .resultContent').each((_, el) => {
      const title   = $(el).find('h2.jobTitle span, [class*="jobTitle"]').first().text().trim();
      const company = $(el).find('[data-testid="company-name"], .companyName').first().text().trim();
      const loc     = $(el).find('[data-testid="text-location"], .companyLocation').first().text().trim() || 'UAE';
      const link    = $(el).find('a[id^="job_"]').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'Indeed UAE', link: link.startsWith('http')?link:'https://ae.indeed.com'+link });
    });
  } catch (e) { console.error('[Indeed UAE]', e.message); }
  return leads;
}

async function scrapeBayt() {
  const leads = [];
  try {
    const r = await http.get('https://www.bayt.com/en/uae/jobs/sales-manager-jobs/');
    const $ = cheerio.load(r.data);
    $('li[data-js-job], .hasNotSeen').each((_, el) => {
      const title   = $(el).find('[class*="job-name"], h2.t-20').first().text().trim();
      const company = $(el).find('[class*="company"], .jb-company').first().text().trim();
      const loc     = $(el).find('[class*="location"], .jb-loc').first().text().trim() || 'UAE';
      const link    = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'Bayt', link: link.startsWith('http')?link:'https://www.bayt.com'+link });
    });
  } catch (e) { console.error('[Bayt]', e.message); }
  return leads;
}

async function scrapeGoogleJobsUAE() {
  const leads = [];
  try {
    const r = await http.get('https://www.google.com/search?q=sales+manager+jobs+Dubai+UAE&ibp=htl;jobs', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    const $ = cheerio.load(r.data);
    $('[class*="job"], [jscontroller]').each((_, el) => {
      const title   = $(el).find('[class*="title"], [jsname]').first().text().trim();
      const company = $(el).find('[class*="company"]').first().text().trim();
      if (title && title.length > 5 && title.length < 120) {
        leads.push({ title, company: company||'Employer', location:'Dubai, UAE', source:'Google Jobs UAE', link:'https://www.google.com/search?q='+encodeURIComponent(title+' '+company)+'+jobs+dubai' });
      }
    });
  } catch (e) { console.error('[Google Jobs UAE]', e.message); }
  return leads;
}

async function scrapeGoogleJobsLB() {
  const leads = [];
  try {
    const r = await http.get('https://www.google.com/search?q=sales+director+jobs+Lebanon+Beirut&ibp=htl;jobs', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' }
    });
    const $ = cheerio.load(r.data);
    $('[class*="job"], [jscontroller]').each((_, el) => {
      const title   = $(el).find('[class*="title"], [jsname]').first().text().trim();
      const company = $(el).find('[class*="company"]').first().text().trim();
      if (title && title.length > 5 && title.length < 120) {
        leads.push({ title, company: company||'Employer', location:'Beirut, Lebanon', source:'Google Jobs Lebanon', link:'https://www.google.com/search?q='+encodeURIComponent(title+' '+company)+'+jobs+lebanon' });
      }
    });
  } catch (e) { console.error('[Google Jobs Lebanon]', e.message); }
  return leads;
}

async function scrapeRemoteOK() {
  const leads = [];
  try {
    const r = await http.get('https://remoteok.com/remote-sales-jobs', { headers: { 'Accept': 'application/json' } });
    let jobs = [];
    try { jobs = JSON.parse(r.data); } catch { /* HTML fallback */ }
    if (Array.isArray(jobs) && jobs.length > 1) {
      jobs.filter(j => j && !j.legal).slice(0, 30).forEach(j => {
        const title = j.position || '';
        if (title) leads.push({ title, company: j.company||'Remote', location:'Remote / MENA', source:'RemoteOK', link: j.url || j.apply_url || 'https://remoteok.com' });
      });
    } else {
      const $ = cheerio.load(r.data);
      $('tr.job, [data-id]').each((_, el) => {
        const title   = $(el).find('h2, [itemprop="title"]').first().text().trim();
        const company = $(el).find('.company h3, [itemprop="name"]').first().text().trim();
        const link    = $(el).find('a[href^="/remote"]').first().attr('href') || '';
        if (title) leads.push({ title, company: company||'Remote', location:'Remote / MENA', source:'RemoteOK', link: 'https://remoteok.com'+link });
      });
    }
  } catch (e) { console.error('[RemoteOK]', e.message); }
  return leads;
}

async function scrapeAkhtaboot() {
  const leads = [];
  try {
    const r = await http.get('https://www.akhtaboot.com/en/search-jobs?q=sales+manager&location=UAE');
    const $ = cheerio.load(r.data);
    $('.job-post-item, .job-item, .result-item').each((_, el) => {
      const title   = $(el).find('.job-title, h2, h3').first().text().trim();
      const company = $(el).find('.company-name, .employer-name').first().text().trim();
      const loc     = $(el).find('.job-location, .location').first().text().trim() || 'UAE';
      const link    = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'Akhtaboot', link: link.startsWith('http')?link:'https://www.akhtaboot.com'+link });
    });
  } catch (e) { console.error('[Akhtaboot]', e.message); }
  return leads;
}

async function scrapeJobsForLebanon() {
  const leads = [];
  try {
    const r = await http.get('https://www.jobsforlebanon.com/jobs/search/?keyword=sales&location=beirut');
    const $ = cheerio.load(r.data);
    $('.job-item, .vacancy-item, article').each((_, el) => {
      const title   = $(el).find('h2, h3, .job-title').first().text().trim();
      const company = $(el).find('.company, .employer').first().text().trim();
      const loc     = $(el).find('.location').first().text().trim() || 'Lebanon';
      const link    = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'JobsForLebanon', link: link.startsWith('http')?link:'https://www.jobsforlebanon.com'+link });
    });
  } catch (e) { console.error('[JobsForLebanon]', e.message); }
  return leads;
}

async function scrapeNaukriGulf() {
  const leads = [];
  try {
    const r = await http.get('https://www.naukrigulf.com/sales-jobs');
    const $ = cheerio.load(r.data);
    $('[class*="ni-job-tuple"], [class*="jobTuple"], .job-card').each((_, el) => {
      const title   = $(el).find('[class*="title"], a.title').first().text().trim();
      const company = $(el).find('[class*="company"], .comp-name').first().text().trim();
      const loc     = $(el).find('[class*="location"], .locWdth').first().text().trim() || 'UAE';
      const link    = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'NaukriGulf', link: link.startsWith('http')?link:'https://www.naukrigulf.com'+link });
    });
  } catch (e) { console.error('[NaukriGulf]', e.message); }
  return leads;
}

async function scrapeLaimoon() {
  const leads = [];
  try {
    const r = await http.get('https://www.laimoon.com/jobs/search?q=sales+manager&location=Dubai+UAE');
    const $ = cheerio.load(r.data);
    $('article.job, .job-listing, .job-card').each((_, el) => {
      const title   = $(el).find('h2, h3, .job-title').first().text().trim();
      const company = $(el).find('.company, .employer').first().text().trim();
      const loc     = $(el).find('.location').first().text().trim() || 'UAE';
      const link    = $(el).find('a').first().attr('href') || '';
      if (title) leads.push({ title, company: company||'Employer', location: loc, source:'Laimoon', link: link.startsWith('http')?link:'https://www.laimoon.com'+link });
    });
  } catch (e) { console.error('[Laimoon]', e.message); }
  return leads;
}

// ─── MAIN RUN ─────────────────────────────────────────────────────────────────
async function run() {
  console.log('[engine] Starting — ' + new Date().toISOString());

  const scrapers = [
    scrapeOpenSooqUAE, scrapeOpenSooqLB, scrapeDubizzle, scrapeOLXLebanon,
    scrapeExpatriatesUAE, scrapeExpatriatesLB, scrapeIndeedUAE, scrapeBayt,
    scrapeGoogleJobsUAE, scrapeGoogleJobsLB, scrapeRemoteOK, scrapeAkhtaboot,
    scrapeJobsForLebanon, scrapeNaukriGulf, scrapeLaimoon,
  ];

  const results = await Promise.allSettled(scrapers.map(fn => fn()));
  const rawAll = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
  console.log('[engine] Raw scraped: ' + rawAll.length);

  const existing = fs.existsSync(LEADS_FILE) ? JSON.parse(fs.readFileSync(LEADS_FILE)) : [];
  const seen = loadDedup();

  let newCount = 0;
  const normalized = rawAll
    .filter(r => r.title && r.title.length > 3)
    .map(r => scoreAndNormalize(r))
    .filter(lead => {
      const key = dedupKey(lead);
      if (seen.has(key)) return false;
      seen.add(key);
      newCount++;
      return true;
    });

  const merged = [
    ...normalized,
    ...existing.filter(l => !normalized.find(n => n.id === l.id)),
  ].slice(0, 2000);

  fs.writeFileSync(LEADS_FILE, JSON.stringify(merged, null, 2));
  saveDedup(seen);

  const state = {
    lastRun: new Date().toISOString(),
    total: merged.length,
    newThisRun: newCount,
    hot: merged.filter(l => l.heat === 'Hot').length,
    warm: merged.filter(l => l.heat === 'Warm').length,
    withPhone: merged.filter(l => l.phone || l.whatsapp || l.contactPhone).length,
    hirers: merged.filter(l => l.leadType === 'HIRER').length,
    talent: merged.filter(l => l.leadType === 'TALENT').length,
    sources: rawAll.reduce((acc, r) => { acc[r.source] = (acc[r.source]||0)+1; return acc; }, {}),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`[engine] Done — ${newCount} new, ${merged.length} total, ${state.hot} hot`);
  return { newCount, total: merged.length, leads: merged, state };
}

// Keep backward compat alias for anything that still calls runScrapeAndPush
async function runScrapeAndPush() { return run(); }

module.exports = { run, runScrapeAndPush };

// Direct execution: node scraper/engine.js
if (require.main === module) {
  run().then(r => {
    console.log('[engine] Complete:', JSON.stringify({ newCount: r.newCount, total: r.total, hot: r.state?.hot }));
    process.exit(0);
  }).catch(e => {
    console.error('[engine] Fatal:', e.message);
    process.exit(1);
  });
}
