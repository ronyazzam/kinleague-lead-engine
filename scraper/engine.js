'use strict';
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const CRM_SUPABASE_URL = 'https://babhsufcvybimxysgvwb.supabase.co';
const CRM_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhYmhzdWZjdnliaW14eXNndndiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1OTk0MTgsImV4cCI6MjA5NjE3NTQxOH0.CgOQgPhLYD_FnTgF9Sm2NGETDll9dQT8gWCkFtpcsHc';
const DATA_DIR = path.join(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'leads.json');
const PUSHED_FILE = path.join(DATA_DIR, 'pushed.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const HIRER_TITLE_KEYWORDS = [
  'sales executive','sales manager','sales director','head of sales',
  'vp sales','vp of sales','chief revenue','cro','revenue director',
  'business development','bdm','bdr','bd manager',
  'sdr','sales development','sales development representative',
  'account executive','account manager','key account','enterprise account',
  'marketing manager','marketing director','head of marketing',
  'growth manager','demand generation','performance marketing',
  'digital marketing manager','commercial manager','commercial director',
  'partnerships manager','channel sales','regional sales',
  'territory manager','field sales','inside sales','outbound sales',
  'pre-sales','presales','solutions consultant','revenue manager',
];

const TALENT_SIGNALS = [
  'open to work','looking for','seeking a role','available for',
  'job seeker','actively looking','open for opportunities',
  'seeking new opportunities','available immediately',
  'exploring opportunities','looking for sales role',
  'years in sales','sales career',
];

const HIRER_SIGNALS = [
  'we are hiring','we\'re hiring','now hiring','join our team',
  'we are looking for','open position','job opening','vacancy',
  'apply now','immediate opening','urgent requirement','we need a',
  'looking to hire','growing our team','position available',
];

const EXCLUDE_ALWAYS = [
  'software engineer','developer','devops','data scientist',
  'machine learning','frontend','backend','fullstack',
  'accountant','financial analyst','cfo',
  'doctor','nurse','medical','pharmacist',
  'driver','delivery','logistics','warehouse',
  'receptionist','office manager','hr manager',
  'designer','graphic','ux designer',
  'content writer','copywriter','teacher','professor',
];

const MARKETS = {
  UAE: ['dubai','abu dhabi','sharjah','uae','united arab emirates','ajman'],
  USA: ['united states','usa',' us ','new york','los angeles','chicago','san francisco','remote','austin','miami','boston','seattle'],
  LEBANON: ['lebanon','beirut','jounieh','tripoli','sidon'],
};

function detectLeadType(title, description, postType) {
  const text = (title + ' ' + (description || '')).toLowerCase();
  if (EXCLUDE_ALWAYS.some(k => text.includes(k))) return null;
  const hasSalesKeyword = HIRER_TITLE_KEYWORDS.some(k => text.includes(k));
  if (!hasSalesKeyword) return null;
  if (postType === 'job_board') return 'HIRER';
  const hasTalentSignal = TALENT_SIGNALS.some(s => text.includes(s));
  const hasHirerSignal = HIRER_SIGNALS.some(s => text.includes(s));
  if (hasTalentSignal && !hasHirerSignal) return 'TALENT';
  if (hasHirerSignal) return 'HIRER';
  return 'HIRER';
}

function detectMarket(location) {
  const loc = (location || '').toLowerCase();
  for (const [market, keywords] of Object.entries(MARKETS)) {
    if (keywords.some(k => loc.includes(k))) return market;
  }
  return 'OTHER';
}

function scoreLead(lead) {
  let score = 0;
  const title = (lead.title || '').toLowerCase();
  if (title.includes('director') || title.includes('vp') || title.includes('head') || title.includes('chief')) score += 35;
  else if (title.includes('manager') || title.includes('executive') || title.includes('lead')) score += 25;
  else if (title.includes('sdr') || title.includes('bdr') || title.includes('development')) score += 20;
  else score += 10;
  const hoursAgo = (Date.now() - new Date(lead.postedAt || Date.now()).getTime()) / 3600000;
  if (hoursAgo < 1) score += 50;
  else if (hoursAgo < 6) score += 40;
  else if (hoursAgo < 24) score += 25;
  else if (hoursAgo < 72) score += 10;
  if (lead.contactPhone) score += 35;  // phone > email — direct dial is gold
  if (lead.contactEmail) score += 20;
  if (lead.market === 'UAE') score += 15;
  else if (lead.market === 'LEBANON') score += 12;
  else if (lead.market === 'USA') score += 10;
  if (lead.source === 'LinkedIn') score += 10;
  if (lead.source === 'Bayt') score += 8;
  if (lead.leadType === 'HIRER') score += 10;
  lead.score = score;
  lead.heat = score >= 70 ? 'Hot' : score >= 45 ? 'Warm' : 'Cold';
  return lead;
}

function generateMessage(lead) {
  const co = lead.company || 'your company';
  const role = lead.title || 'the role';
  const loc = lead.location || '';
  if (lead.leadType === 'HIRER') {
    const msgs = {
      Hot: `Hi — noticed ${co} is hiring a ${role}${loc ? ' in ' + loc : ''}. We place pre-vetted Sales & Marketing talent in 72 hours at 10% of annual salary. Lebanese professionals — multilingual, commercially sharp, and up to 50% more cost-effective than local hires. Worth a quick call this week?`,
      Warm: `Hi — saw ${co} is looking for a ${role}. Kinleague specialises in Sales & Marketing placement across UAE, Lebanon, and the US — pre-vetted shortlist in 72 hours, 10% fee. Happy to share how it works?`,
      Cold: `Hi — we help companies hire Sales and Marketing talent in 72 hours. Seeing ${co} is hiring — let me know if that could be useful.`,
    };
    return msgs[lead.heat] || msgs.Warm;
  }
  const msgs = {
    Hot: `Hi — your background in ${role} looks like a strong fit for roles we're filling right now in ${lead.market === 'UAE' ? 'Dubai' : lead.market === 'USA' ? 'the US' : 'the region'}. We're completely free for candidates and handle everything from intro to offer. Open to a quick call this week?`,
    Warm: `Hi — we place Sales & Marketing professionals in Dubai, the US, and Lebanon. Based on your profile, we may have relevant openings. Interested in hearing more? No cost to you.`,
    Cold: `Hi — Kinleague places Sales talent in Dubai and the US. We're free for candidates. If you're open to new opportunities, we'd love to connect.`,
  };
  return msgs[lead.heat] || msgs.Warm;
}

function generateEmailSubject(lead) {
  if (lead.leadType === 'HIRER') return `${lead.company} — Sales Talent Ready in 72 Hours | Kinleague`;
  return `${lead.title || 'Sales Role'} Opportunity — ${lead.market === 'UAE' ? 'Dubai' : lead.market} | Kinleague`;
}

// Aggressive phone regexes — UAE (+971), Lebanon (+961), US (+1), generic intl
const PHONE_PATTERNS = [
  /(\+971[\s\-]?(?:50|52|54|55|56|58|2|3|4|6|7|9)[\s\-]?\d{3}[\s\-]?\d{4})/g,  // UAE mobile/landline
  /(\+961[\s\-]?\d[\s\-]?\d{3}[\s\-]?\d{3,4})/g,                                  // Lebanon
  /(\+1[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{4})/g,                             // US
  /(\+\d{1,3}[\s\-]?\(?\d{1,4}\)?[\s\-]?\d{3,5}[\s\-]?\d{4,6})/g,               // Generic intl with +
  /((?:050|052|054|055|056|058|04|02|06|07|03|09)[\s\-]?\d{3}[\s\-]?\d{4})/g,    // UAE local format
  /((?:01|03|70|71|76|78|79|81)[\s\-]?\d{3}[\s\-]?\d{3,4})/g,                    // Lebanon local
  /((?:\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}))/g,                                // US local
];

function extractPhones(text) {
  const found = new Set();
  for (const re of PHONE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const digits = m[1].replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) found.add(m[1].trim());
    }
  }
  // filter out obvious non-phones (years, IDs)
  return [...found].filter(p => !/^(19|20)\d{2}$/.test(p.replace(/\D/g,'')));
}

function extractEmails(text) {
  return (text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [])
    .filter(e => !['noreply','no-reply','sentry','cloudflare','example','test','wix','mailchimp','bounce','support@sentry','notifications@'].some(x => e.toLowerCase().includes(x)));
}

async function fetchPage(url, timeout = 8000) {
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout,
    maxRedirects: 5,
  });
  return data;
}

async function enrichContact(lead) {
  // ── 1. Try job listing page first ──────────────────────────────────────────
  const skipDomains = ['linkedin.com','indeed.com','glassdoor.com'];
  if (lead.link && lead.link !== '#' && !skipDomains.some(d => lead.link.includes(d))) {
    try {
      await delay(400);
      const html = await fetchPage(lead.link);
      const text = cheerio.load(html).text();

      // PHONE first (highest priority)
      if (!lead.contactPhone) {
        const phones = extractPhones(text);
        if (phones[0]) lead.contactPhone = phones[0];
      }
      if (!lead.contactEmail) {
        const emails = extractEmails(text);
        if (emails[0]) lead.contactEmail = emails[0];
      }
      if (!lead.contactName) {
        const nm = text.match(/(?:contact|apply to|send to|reach|hiring manager|hr contact|recruiter)[\s:]+([A-Z][a-z]+ [A-Z][a-z]+)/i);
        if (nm) lead.contactName = nm[1];
      }
      // Extract company domain from link
      if (!lead.companyDomain) {
        try {
          const u = new URL(lead.link);
          if (!skipDomains.concat(['bayt.com','naukrigulf.com','wuzzuf.net','remoteok.com']).includes(u.hostname.replace('www.',''))) {
            lead.companyDomain = u.hostname.replace('www.','');
          }
        } catch {}
      }
    } catch {}
  }

  // ── 2. Scrape company website for phone + email ─────────────────────────────
  if ((!lead.contactPhone || !lead.contactEmail) && lead.companyDomain) {
    for (const page of ['/contact', '/contact-us', '/about', '/about-us', '']) {
      try {
        await delay(300);
        const html = await fetchPage(`https://${lead.companyDomain}${page}`, 6000);
        const text = cheerio.load(html).text();
        if (!lead.contactPhone) {
          const phones = extractPhones(text);
          if (phones[0]) lead.contactPhone = phones[0];
        }
        if (!lead.contactEmail) {
          const emails = extractEmails(text);
          if (emails[0]) lead.contactEmail = emails[0];
        }
        if (lead.contactPhone && lead.contactEmail) break;
      } catch {}
    }
  }

  // ── 3. Set probable emails if nothing found ─────────────────────────────────
  if (!lead.companyDomain && lead.link) {
    try {
      const u = new URL(lead.link);
      const skip = ['linkedin.com','indeed.com','bayt.com','glassdoor.com','naukrigulf.com','wuzzuf.net','remoteok.com'];
      if (!skip.includes(u.hostname.replace('www.',''))) lead.companyDomain = u.hostname.replace('www.','');
    } catch {}
  }
  if (!lead.contactEmail && lead.companyDomain) {
    lead.probableEmails = [
      `hiring@${lead.companyDomain}`,
      `hr@${lead.companyDomain}`,
      `careers@${lead.companyDomain}`,
      `hello@${lead.companyDomain}`,
      `recruit@${lead.companyDomain}`,
    ];
  }

  return lead;
}

const UA_LIST = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
];
function randomUA() { return UA_LIST[Math.floor(Math.random()*UA_LIST.length)]; }
async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeLinkedInJobs(url, market) {
  try {
    await delay(1000 + Math.random()*1000);
    const { data } = await axios.get(url, { headers:{'User-Agent':randomUA(),'Accept-Language':'en-US,en;q=0.9'}, timeout:15000 });
    const $ = cheerio.load(data);
    const leads = [];
    $('.base-card').each((i,el) => {
      const title = $(el).find('.base-search-card__title').text().trim();
      const company = $(el).find('.base-search-card__subtitle').text().trim();
      const location = $(el).find('.job-search-card__location').text().trim();
      const time = $(el).find('time').attr('datetime') || new Date().toISOString();
      const link = $(el).find('a.base-card__full-link, a').first().attr('href') || '';
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id: Buffer.from(company+title+time).toString('base64').slice(0,16), title, company, location, market: market || detectMarket(location), postedAt: time, link: link.split('?')[0], source:'LinkedIn', leadType:type, scrapedAt:new Date().toISOString() });
    });
    return leads;
  } catch(e) { console.error('LinkedIn failed:',e.message); return []; }
}

async function scrapeIndeed(url, market) {
  try {
    await delay(1000 + Math.random()*1000);
    const { data } = await axios.get(url, { headers:{'User-Agent':randomUA()}, timeout:15000 });
    const $ = cheerio.load(data);
    const leads = [];
    $('[data-jk]').each((i,el) => {
      const title = $(el).find('[class*="jobTitle"]').text().trim();
      const company = $(el).find('[data-testid="company-name"]').text().trim();
      const location = $(el).find('[data-testid="text-location"]').text().trim();
      const jk = $(el).attr('data-jk');
      if (!title || !company || !jk) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id:'indeed_'+jk, title, company, location, market: market || detectMarket(location), postedAt:new Date().toISOString(), link:`https://ae.indeed.com/viewjob?jk=${jk}`, source:'Indeed', leadType:type, scrapedAt:new Date().toISOString() });
    });
    return leads;
  } catch(e) { console.error('Indeed failed:',e.message); return []; }
}

async function scrapeBayt(url, market) {
  try {
    await delay(1000 + Math.random()*1000);
    const { data } = await axios.get(url, { headers:{'User-Agent':randomUA()}, timeout:15000 });
    const $ = cheerio.load(data);
    const leads = [];
    $('[data-job-id], .has-pointer-d').each((i,el) => {
      const title = $(el).find('h2 a, [class*="title"] a').first().text().trim();
      const company = $(el).find('[class*="company"], [class*="jb-company"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || market || 'UAE';
      const link = $(el).find('a').first().attr('href') || '';
      const fullLink = link.startsWith('http') ? link : 'https://www.bayt.com'+link;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id:'bayt_'+Buffer.from(company+title).toString('base64').slice(0,12), title, company, location, market: market || detectMarket(location), postedAt:new Date().toISOString(), link:fullLink, source:'Bayt', leadType:type, scrapedAt:new Date().toISOString() });
    });
    return leads;
  } catch(e) { console.error('Bayt failed:',e.message); return []; }
}

async function scrapeNaukriGulf(url, market) {
  try {
    await delay(1000 + Math.random()*1000);
    const { data } = await axios.get(url, { headers:{'User-Agent':randomUA()}, timeout:15000 });
    const $ = cheerio.load(data);
    const leads = [];
    $('[class*="job-listing"], [class*="jobListing"], li[data-id], .ni-job-tuple').each((i,el) => {
      const title = $(el).find('a[class*="title"], h2 a, h3 a, .title').first().text().trim();
      const company = $(el).find('[class*="company"], [class*="employer"], .company').first().text().trim();
      const location = $(el).find('[class*="location"], .location').first().text().trim() || 'UAE';
      const link = $(el).find('a').first().attr('href') || '';
      const fullLink = link.startsWith('http') ? link : 'https://www.naukrigulf.com'+link;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id:'ng_'+Buffer.from(company+title).toString('base64').slice(0,12), title, company, location, market:market||'UAE', postedAt:new Date().toISOString(), link:fullLink, source:'NaukriGulf', leadType:type, scrapedAt:new Date().toISOString() });
    });
    return leads;
  } catch(e) { console.error('NaukriGulf failed:',e.message); return []; }
}

async function scrapeWuzzuf(url) {
  try {
    await delay(1000 + Math.random()*1000);
    const { data } = await axios.get(url, { headers:{'User-Agent':randomUA()}, timeout:15000 });
    const $ = cheerio.load(data);
    const leads = [];
    $('article[data-jobid], [class*="job-card"], .wuzf-job').each((i,el) => {
      const title = $(el).find('h2 a, h3 a, [class*="title"] a').first().text().trim();
      const company = $(el).find('[class*="company"]').first().text().trim();
      const location = $(el).find('[class*="location"]').first().text().trim() || 'MENA';
      const link = $(el).find('a').first().attr('href') || '';
      const fullLink = link.startsWith('http') ? link : 'https://wuzzuf.net'+link;
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id:'wz_'+Buffer.from(company+title).toString('base64').slice(0,12), title, company, location, market:detectMarket(location), postedAt:new Date().toISOString(), link:fullLink, source:'Wuzzuf', leadType:type, scrapedAt:new Date().toISOString() });
    });
    return leads;
  } catch(e) { console.error('Wuzzuf failed:',e.message); return []; }
}

async function scrapeGlassdoor(url, market) {
  try {
    await delay(1500 + Math.random()*1000);
    const { data } = await axios.get(url, { headers:{'User-Agent':randomUA()}, timeout:15000 });
    const $ = cheerio.load(data);
    const leads = [];
    $('[data-test="jobListing"], .react-job-listing, [class*="JobsList_jobListItem"]').each((i,el) => {
      const title = $(el).find('[data-test="job-title"], [class*="JobCard_jobTitle"], .job-title').first().text().trim();
      const company = $(el).find('[data-test="employer-name"], [class*="JobCard_employer"]').first().text().trim();
      const location = $(el).find('[data-test="emp-location"], [class*="JobCard_location"]').first().text().trim() || market || 'UAE';
      if (!title || !company) return;
      const type = detectLeadType(title, '', 'job_board');
      if (!type) return;
      leads.push({ id:'gd_'+Buffer.from(company+title).toString('base64').slice(0,12), title, company, location, market:market||detectMarket(location), postedAt:new Date().toISOString(), link:url, source:'Glassdoor', leadType:type, scrapedAt:new Date().toISOString() });
    });
    return leads;
  } catch(e) { console.error('Glassdoor failed:',e.message); return []; }
}

async function scrapeRemoteOK() {
  try {
    const { data } = await axios.get('https://remoteok.com/remote-sales-jobs.json', { headers:{'User-Agent':'Mozilla/5.0','Accept':'application/json'}, timeout:10000 });
    if (!Array.isArray(data)) return [];
    return data.filter(j => j && j.position && detectLeadType(j.position, j.description||'', 'job_board')).map(j => ({
      id: 'rok_'+j.id, title:j.position, company:j.company||'', location:j.location||'Remote',
      market:'USA', postedAt:j.date||new Date().toISOString(),
      link:j.url||`https://remoteok.com/remote-jobs/${j.id}`,
      source:'RemoteOK', leadType:'HIRER', contactEmail:j.email||null, scrapedAt:new Date().toISOString()
    }));
  } catch(e) { console.error('RemoteOK failed:',e.message); return []; }
}

// Demo fallback
function getDemoLeads() {
  return [
    { title:'Head of Sales', company:'Noon.com', location:'Dubai, UAE', source:'LinkedIn', postedAt:new Date(Date.now()-2*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'VP of Sales', company:'Careem', location:'Dubai, UAE', source:'LinkedIn', postedAt:new Date(Date.now()-4*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'Sales Director', company:'Talabat', location:'Dubai, UAE', source:'LinkedIn', postedAt:new Date(Date.now()-6*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'Business Development Manager', company:'Property Finder', location:'Dubai, UAE', source:'Indeed', postedAt:new Date(Date.now()-8*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'Enterprise Sales Manager', company:'Salesforce UAE', location:'Dubai, UAE', source:'Glassdoor', postedAt:new Date(Date.now()-10*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'Sales Executive', company:'Anghami', location:'Beirut, Lebanon', source:'LinkedIn', postedAt:new Date(Date.now()-12*36e5).toISOString(), leadType:'HIRER', market:'LEBANON' },
    { title:'Growth Manager', company:'Kitopi', location:'Dubai, UAE', source:'LinkedIn', postedAt:new Date(Date.now()-15*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'Account Executive', company:'HubSpot MENA', location:'Dubai, UAE', source:'LinkedIn', postedAt:new Date(Date.now()-18*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'Sales Manager', company:'Emaar Properties', location:'Dubai, UAE', source:'Bayt', postedAt:new Date(Date.now()-20*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'Regional Sales Manager', company:'Aramex', location:'Dubai, UAE', source:'LinkedIn', postedAt:new Date(Date.now()-22*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'Account Executive', company:'Salesforce', location:'New York, USA', source:'RemoteOK', postedAt:new Date(Date.now()-5*36e5).toISOString(), leadType:'HIRER', market:'USA' },
    { title:'SDR Team Lead', company:'HubSpot', location:'Remote, USA', source:'RemoteOK', postedAt:new Date(Date.now()-8*36e5).toISOString(), leadType:'HIRER', market:'USA' },
    { title:'VP Sales', company:'Stripe', location:'San Francisco, USA', source:'LinkedIn', postedAt:new Date(Date.now()-3*36e5).toISOString(), leadType:'HIRER', market:'USA' },
    { title:'Marketing Manager', company:'Dubizzle', location:'Dubai, UAE', source:'Bayt', postedAt:new Date(Date.now()-25*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
    { title:'BDM - SaaS', company:'Wamda', location:'Dubai, UAE', source:'LinkedIn', postedAt:new Date(Date.now()-30*36e5).toISOString(), leadType:'HIRER', market:'UAE' },
  ].map(l => ({
    ...l,
    id: 'demo_'+Buffer.from(l.company+l.title).toString('base64').slice(0,12),
    scrapedAt: new Date().toISOString()
  }));
}

const SEARCH_TARGETS = [
  { fn:scrapeLinkedInJobs, args:['https://www.linkedin.com/jobs/search/?keywords=sales+executive+marketing+manager&location=Dubai%2C+UAE&f_TPR=r3600&sortBy=DD','UAE'], label:'LinkedIn Dubai Sales' },
  { fn:scrapeLinkedInJobs, args:['https://www.linkedin.com/jobs/search/?keywords=SDR+BDR+business+development+sales&location=United+Arab+Emirates&f_TPR=r3600&sortBy=DD','UAE'], label:'LinkedIn UAE BDR/SDR' },
  { fn:scrapeLinkedInJobs, args:['https://www.linkedin.com/jobs/search/?keywords=head+of+sales+director+revenue+VP&location=UAE&f_TPR=r86400','UAE'], label:'LinkedIn UAE Leadership' },
  { fn:scrapeLinkedInJobs, args:['https://www.linkedin.com/jobs/search/?keywords=sales+marketing+business+development&location=Lebanon&f_TPR=r604800','LEBANON'], label:'LinkedIn Lebanon' },
  { fn:scrapeLinkedInJobs, args:['https://www.linkedin.com/jobs/search/?keywords=account+executive+sales+manager&location=United+States&f_WT=2&f_TPR=r3600&sortBy=DD','USA'], label:'LinkedIn USA Remote Sales' },
  { fn:scrapeLinkedInJobs, args:['https://www.linkedin.com/jobs/search/?keywords=SDR+BDR+sales+development+representative&location=United+States&f_TPR=r86400','USA'], label:'LinkedIn USA SDR/BDR' },
  { fn:scrapeIndeed, args:['https://ae.indeed.com/jobs?q=sales+executive+marketing+manager+business+development&l=Dubai&fromage=1&sort=date','UAE'], label:'Indeed Dubai' },
  { fn:scrapeIndeed, args:['https://ae.indeed.com/jobs?q=SDR+BDR+account+executive+sales+development&fromage=3','UAE'], label:'Indeed UAE SDR' },
  { fn:scrapeIndeed, args:['https://lb.indeed.com/jobs?q=sales+marketing+business+development&fromage=14&sort=date','LEBANON'], label:'Indeed Lebanon' },
  { fn:scrapeIndeed, args:['https://www.indeed.com/jobs?q=account+executive+sales+manager+SDR&l=remote&fromage=1&sort=date','USA'], label:'Indeed USA Remote' },
  { fn:scrapeBayt, args:['https://www.bayt.com/en/uae/jobs/sales-executive-jobs/','UAE'], label:'Bayt UAE Sales' },
  { fn:scrapeBayt, args:['https://www.bayt.com/en/uae/jobs/marketing-manager-jobs/','UAE'], label:'Bayt UAE Marketing' },
  { fn:scrapeBayt, args:['https://www.bayt.com/en/uae/jobs/business-development-manager-jobs/','UAE'], label:'Bayt UAE BDM' },
  { fn:scrapeBayt, args:['https://www.bayt.com/en/lebanon/jobs/sales-manager-jobs/','LEBANON'], label:'Bayt Lebanon Sales' },
  { fn:scrapeNaukriGulf, args:['https://www.naukrigulf.com/sales-executive-jobs-in-uae','UAE'], label:'NaukriGulf UAE Sales' },
  { fn:scrapeNaukriGulf, args:['https://www.naukrigulf.com/marketing-manager-jobs-in-uae','UAE'], label:'NaukriGulf UAE Marketing' },
  { fn:scrapeGlassdoor, args:['https://www.glassdoor.com/Job/dubai-sales-jobs-SRCH_IL.0,5_IC2204498_KO6,11.htm','UAE'], label:'Glassdoor Dubai' },
  { fn:scrapeWuzzuf, args:['https://wuzzuf.net/search/jobs/?q=sales+executive+marketing+manager&a=hpb'], label:'Wuzzuf MENA' },
  { fn:scrapeRemoteOK, args:[], label:'RemoteOK Sales' },
];

async function pushToCRM(lead) {
  try {
    const payload = {
      name: lead.leadType === 'HIRER' ? (lead.company || lead.title) : (lead.contactName || lead.title || 'Sales Professional'),
      email: lead.contactEmail || lead.probableEmails?.[0] || '',
      enquiry_type: lead.leadType === 'HIRER' ? 'hire' : 'talent',
      role: lead.title || '',
      message: [
        `LEAD TYPE: ${lead.leadType}`,
        `HEAT: ${lead.heat} | SCORE: ${lead.score}`,
        `MARKET: ${lead.market}`,
        `SOURCE: ${lead.source}`,
        `LOCATION: ${lead.location || ''}`,
        `POSTED: ${lead.postedAt}`,
        `LINK: ${lead.link || ''}`,
        lead.contactEmail ? `EMAIL: ${lead.contactEmail}` : '',
        lead.contactPhone ? `PHONE: ${lead.contactPhone}` : '',
        lead.probableEmails?.length ? `PROBABLE EMAILS: ${lead.probableEmails.join(', ')}` : '',
        '',
        'SUGGESTED OUTREACH:',
        lead.message || '',
      ].filter(Boolean).join('\n'),
      source: 'lead_engine_auto',
      created_at: new Date().toISOString()
    };
    const res = await axios.post(`${CRM_SUPABASE_URL}/rest/v1/website_leads`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'apikey': CRM_SUPABASE_KEY,
        'Authorization': `Bearer ${CRM_SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      timeout: 10000
    });
    return res.status === 201 || res.status === 200;
  } catch(e) { console.error('CRM push failed for', lead.company, ':', e.message); return false; }
}

function deduplicateLeads(existing, incoming) {
  const keys = new Set(existing.map(l => `${(l.company||'').toLowerCase().trim()}|${(l.title||'').toLowerCase().trim()}`));
  return incoming.filter(l => {
    const key = `${(l.company||'').toLowerCase().trim()}|${(l.title||'').toLowerCase().trim()}`;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
}

async function runScrapeAndPush() {
  const t0 = Date.now();
  console.log(`\n[${new Date().toISOString()}] === Kinleague Lead Engine Starting ===`);

  let existingLeads = [];
  let pushedIds = new Set();
  try { if (fs.existsSync(DATA_FILE)) existingLeads = JSON.parse(fs.readFileSync(DATA_FILE)); } catch {}
  try { if (fs.existsSync(PUSHED_FILE)) pushedIds = new Set(JSON.parse(fs.readFileSync(PUSHED_FILE))); } catch {}

  let freshLeads = [];
  for (const target of SEARCH_TARGETS) {
    try {
      process.stdout.write(`  Scraping ${target.label}... `);
      const leads = await target.fn(...target.args);
      console.log(`${leads.length} leads`);
      freshLeads = [...freshLeads, ...leads];
    } catch(e) { console.log('FAILED:', e.message); }
    await delay(600);
  }
  console.log(`\nTotal raw: ${freshLeads.length}`);

  // Supplement with demo if too few live results
  if (freshLeads.length < 5) {
    console.log('Low live results — adding demo leads');
    freshLeads = [...freshLeads, ...getDemoLeads()];
  }

  const newLeads = deduplicateLeads(existingLeads, freshLeads);
  console.log(`New (not seen before): ${newLeads.length}`);

  console.log('Enriching contacts...');
  const enriched = [];
  for (let i = 0; i < newLeads.length; i++) {
    process.stdout.write(`  ${i+1}/${newLeads.length} ${newLeads[i].company}...\r`);
    enriched.push(await enrichContact(newLeads[i]));
    await delay(200);
  }
  console.log(`\nWith email: ${enriched.filter(l=>l.contactEmail).length}`);

  const scored = enriched.map(lead => {
    const s = scoreLead(lead);
    s.message = generateMessage(s);
    s.emailSubject = generateEmailSubject(s);
    return s;
  });

  const allLeads = [...scored, ...existingLeads.filter(e => !scored.find(s=>s.id===e.id))].slice(0,5000);
  allLeads.sort((a,b) => {
    const ho = {Hot:0,Warm:1,Cold:2};
    if (ho[a.heat]!==ho[b.heat]) return ho[a.heat]-ho[b.heat];
    return (b.score||0)-(a.score||0);
  });

  fs.writeFileSync(DATA_FILE, JSON.stringify(allLeads, null, 2));

  const csv = ['ID,Type,Company,Role,Location,Market,Source,Heat,Score,Email,Phone,Posted,Link',
    ...allLeads.map(l=>[l.id,l.leadType,l.company,l.title,l.location,l.market,l.source,l.heat,l.score,l.contactEmail||'',l.contactPhone||'',l.postedAt,l.link].map(v=>`"${String(v||'').replace(/"/g,"'")}"`).join(','))
  ].join('\n');
  fs.writeFileSync(DATA_FILE.replace('.json','.csv'), csv);

  const toPush = scored.filter(l => l.heat==='Hot' && !pushedIds.has(l.id) && (l.contactEmail || l.probableEmails?.length));
  console.log(`\nAuto-pushing ${toPush.length} hot leads to CRM...`);
  let pushCount = 0;
  for (const lead of toPush) {
    const ok = await pushToCRM(lead);
    if (ok) { pushedIds.add(lead.id); pushCount++; console.log(`  [${lead.leadType}] ${lead.company} — ${lead.title}`); }
    await delay(400);
  }
  fs.writeFileSync(PUSHED_FILE, JSON.stringify([...pushedIds]));

  const state = {
    lastRun: new Date().toISOString(),
    totalLeads: allLeads.length,
    newThisRun: scored.length,
    hotLeads: allLeads.filter(l=>l.heat==='Hot').length,
    warmLeads: allLeads.filter(l=>l.heat==='Warm').length,
    withPhone: allLeads.filter(l=>l.contactPhone).length,
    withEmail: allLeads.filter(l=>l.contactEmail).length,
    withContact: allLeads.filter(l=>l.contactPhone||l.contactEmail).length,
    hirers: allLeads.filter(l=>l.leadType==='HIRER').length,
    talent: allLeads.filter(l=>l.leadType==='TALENT').length,
    uae: allLeads.filter(l=>l.market==='UAE').length,
    usa: allLeads.filter(l=>l.market==='USA').length,
    lebanon: allLeads.filter(l=>l.market==='LEBANON').length,
    pushedThisRun: pushCount,
    totalPushed: pushedIds.size,
    durationMs: Date.now()-t0,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  console.log(`\n=== DONE in ${((Date.now()-t0)/1000).toFixed(1)}s ===`);
  console.log(`Total: ${allLeads.length} | New: ${scored.length} | Hot: ${state.hotLeads}`);
  console.log(`Hirers: ${state.hirers} | Talent: ${state.talent}`);
  console.log(`UAE: ${state.uae} | USA: ${state.usa} | Lebanon: ${state.lebanon}`);
  console.log(`With email: ${state.withEmail} | Pushed: ${pushCount}`);
  return state;
}

module.exports = { runScrapeAndPush };
if (require.main === module) runScrapeAndPush().catch(console.error);
