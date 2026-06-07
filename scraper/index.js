const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

// ─── SALES-ONLY FILTER ───────────────────────────────────────────────────────
const SALES_ROLE_KEYWORDS = [
  'sales executive','sales manager','sales director','sales lead','head of sales',
  'vp of sales','vp sales','chief revenue','cro','revenue manager','revenue director',
  'business development','bdm','bdr','bd manager','bd executive',
  'sdr','sales development','sales development representative','outbound sales',
  'inside sales','outbound representative',
  'account executive','account manager','key account','strategic account','enterprise account',
  'growth manager','demand generation','performance marketing',
  'marketing manager','marketing director','head of marketing','digital marketing manager','marketing lead',
  'pre-sales','presales','solutions consultant','commercial manager','commercial director',
  'partnerships manager','channel sales','regional sales','territory manager','field sales',
];

const EXCLUDE_KEYWORDS = [
  'software engineer','developer','devops','data scientist','data engineer',
  'machine learning','frontend','backend','fullstack','full stack',
  'accountant','finance manager','financial analyst','cfo','controller',
  'lawyer','legal','paralegal','compliance',
  'doctor','nurse','medical','healthcare','pharmacist',
  'driver','delivery','logistics','warehouse',
  'customer service','support agent','help desk',
  'receptionist','admin assistant','office manager',
  'hr manager','recruiter','talent acquisition',
  'designer','graphic','ui ux','ux designer',
  'content writer','copywriter','seo specialist',
];

function isSalesRole(title) {
  const t = title.toLowerCase();
  if (EXCLUDE_KEYWORDS.some(k => t.includes(k))) return false;
  return SALES_ROLE_KEYWORDS.some(k => t.includes(k));
}

// ─── SEARCH TARGETS ──────────────────────────────────────────────────────────
const SEARCH_TARGETS = [
  { name:'LinkedIn UAE Sales', url:'https://www.linkedin.com/jobs/search/?keywords=sales+executive+marketing&location=United+Arab+Emirates&f_TPR=r86400&sortBy=DD', type:'linkedin' },
  { name:'LinkedIn Dubai SDR', url:'https://www.linkedin.com/jobs/search/?keywords=SDR+BDR+sales+development&location=Dubai&f_TPR=r86400', type:'linkedin' },
  { name:'LinkedIn Lebanon Sales', url:'https://www.linkedin.com/jobs/search/?keywords=sales+marketing+business+development&location=Lebanon&f_TPR=r604800', type:'linkedin' },
  { name:'LinkedIn UAE Marketing', url:'https://www.linkedin.com/jobs/search/?keywords=marketing+director+growth+manager&location=UAE&f_TPR=r86400', type:'linkedin' },
  { name:'Indeed UAE Sales', url:'https://ae.indeed.com/jobs?q=sales+executive+marketing+manager&l=Dubai&fromage=1&sort=date', type:'indeed' },
  { name:'Indeed UAE BDM', url:'https://ae.indeed.com/jobs?q=business+development+manager+SDR&l=UAE&fromage=3', type:'indeed' },
  { name:'Indeed Lebanon', url:'https://lb.indeed.com/jobs?q=sales+marketing+business+development&fromage=7&sort=date', type:'indeed' },
  { name:'Bayt UAE Sales', url:'https://www.bayt.com/en/uae/jobs/sales-executive-jobs/', type:'bayt' },
  { name:'Bayt UAE Marketing', url:'https://www.bayt.com/en/uae/jobs/marketing-manager-jobs/', type:'bayt' },
  { name:'Bayt Lebanon Sales', url:'https://www.bayt.com/en/lebanon/jobs/sales-manager-jobs/', type:'bayt' },
  { name:'Bayt BDM', url:'https://www.bayt.com/en/uae/jobs/business-development-manager-jobs/', type:'bayt' },
  { name:'Glassdoor Dubai Sales', url:'https://www.glassdoor.com/Job/dubai-sales-jobs-SRCH_IL.0,5_IC2204498_KO6,11_IP1.htm', type:'glassdoor' },
  { name:'NaukriGulf Sales UAE', url:'https://www.naukrigulf.com/sales-jobs-in-uae', type:'naukrigulf' },
  { name:'NaukriGulf Marketing', url:'https://www.naukrigulf.com/marketing-jobs-in-uae', type:'naukrigulf' },
  { name:'GulfTalent Sales', url:'https://www.gulftalent.com/jobs/sales-jobs', type:'gulftalent' },
  { name:'Wuzzuf Sales', url:'https://wuzzuf.net/search/jobs/?q=sales+executive+marketing&a=hpb', type:'wuzzuf' },
  { name:'RemoteOK Sales', url:'https://remoteok.com/remote-sales-jobs.json', type:'remoteok' },
];

const UA_LIST = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

function randomUA() { return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]; }
async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── CONTACT ENRICHMENT ──────────────────────────────────────────────────────
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?\d[\d\s\-().]{7,}\d)/g;
const EMAIL_BLOCKLIST = ['noreply','no-reply','example.com','sentry','cloudflare','wix.com','sendgrid','mailchimp'];

async function enrichContactInfo(lead) {
  // Skip LinkedIn/Indeed — they block scraping job detail pages
  if (!lead.link || lead.link.includes('linkedin.com') || lead.link.includes('indeed.com') || lead.link === '#') return lead;
  try {
    await delay(500 + Math.random() * 500);
    const { data } = await axios.get(lead.link, {
      headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 8000
    });
    const emails = (data.match(EMAIL_RE) || []).filter(e => !EMAIL_BLOCKLIST.some(b => e.includes(b)));
    const phones = (data.match(PHONE_RE) || []).filter(p => p.replace(/\D/g,'').length >= 7);
    if (emails.length) lead.contactEmail = emails[0];
    if (phones.length) lead.contactPhone = phones[0].trim();
  } catch {}
  return lead;
}

// ─── SCRAPERS ────────────────────────────────────────────────────────────────
async function scrapeLinkedIn(url, sourceName) {
  try {
    await delay(1000 + Math.random() * 1000);
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': randomUA(),
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const leads = [];

    $('.base-card').each((i, el) => {
      const title = $(el).find('.base-search-card__title').text().trim();
      const company = $(el).find('.base-search-card__subtitle a, .base-search-card__subtitle').first().text().trim();
      const location = $(el).find('.job-search-card__location').text().trim();
      const timeEl = $(el).find('time');
      const time = timeEl.attr('datetime') || new Date().toISOString();
      const link = $(el).find('a.base-card__full-link, a').first().attr('href') || '';

      if (!title || !company) return;
      if (!isSalesRole(title)) return;

      leads.push({ title, company, location: location || 'UAE', postedAt: time, link: link.split('?')[0], source: 'LinkedIn' });
    });

    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json['@type'] === 'JobPosting') {
          const title = json.title || '';
          const company = json.hiringOrganization?.name || '';
          const location = json.jobLocation?.address?.addressLocality || 'UAE';
          if (title && company && isSalesRole(title)) {
            leads.push({ title, company, location, postedAt: json.datePosted || new Date().toISOString(), link: json.url || url, source: 'LinkedIn' });
          }
        }
      } catch {}
    });

    console.log(`  [${sourceName}] → ${leads.length} leads`);
    return leads;
  } catch (err) {
    console.error(`  [${sourceName}] Error: ${err.message}`);
    return [];
  }
}

async function scrapeIndeed(url, sourceName) {
  try {
    await delay(1000 + Math.random() * 1000);
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': randomUA(),
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const leads = [];

    const selectors = ['[data-jk]', '.job_seen_beacon', '.tapItem'];
    for (const sel of selectors) {
      $(sel).each((i, el) => {
        const title = $(el).find('[class*="jobTitle"], h2.jobTitle, .jobTitle').text().trim()
          || $(el).find('a[id*="job_"]').text().trim();
        const company = $(el).find('[data-testid="company-name"], .companyName').text().trim();
        const location = $(el).find('[data-testid="text-location"], .companyLocation').text().trim();
        const jk = $(el).attr('data-jk') || $(el).find('[data-jk]').attr('data-jk');
        const link = jk ? `https://ae.indeed.com/viewjob?jk=${jk}` : '';

        if (!title || !company) return;
        if (!isSalesRole(title)) return;

        leads.push({ title, company, location: location || 'UAE', postedAt: new Date().toISOString(), link, source: 'Indeed' });
      });
      if (leads.length > 0) break;
    }

    console.log(`  [${sourceName}] → ${leads.length} leads`);
    return leads;
  } catch (err) {
    console.error(`  [${sourceName}] Error: ${err.message}`);
    return [];
  }
}

async function scrapeBayt(url, sourceName) {
  try {
    await delay(1000 + Math.random() * 1000);
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const leads = [];

    $('[data-job-id], .has-pointer-d, li[id*="post"]').each((i, el) => {
      const title = $(el).find('h2 a, h3 a, .jb-title, [class*="title"] a').first().text().trim();
      const company = $(el).find('[class*="company"], [class*="employer"], .jb-company').first().text().trim();
      const location = $(el).find('[class*="location"], .jb-loc').first().text().trim();
      const href = $(el).find('h2 a, h3 a, .jb-title a').first().attr('href') || '';
      const link = href.startsWith('http') ? href : `https://www.bayt.com${href}`;

      if (!title || !company) return;
      if (!isSalesRole(title)) return;

      leads.push({ title, company, location: location || 'UAE', postedAt: new Date().toISOString(), link, source: 'Bayt' });
    });

    console.log(`  [${sourceName}] → ${leads.length} leads`);
    return leads;
  } catch (err) {
    console.error(`  [${sourceName}] Error: ${err.message}`);
    return [];
  }
}

async function scrapeGlassdoor(url, sourceName) {
  try {
    await delay(1500 + Math.random() * 1000);
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const leads = [];

    $('[data-test="jobListing"], .react-job-listing, li[class*="JobsList"]').each((i, el) => {
      const title = $(el).find('[data-test="job-title"], .jobLink, [class*="JobCard_jobTitle"]').text().trim();
      const company = $(el).find('[data-test="employer-name"], [class*="JobCard_employer"]').text().trim();
      const location = $(el).find('[data-test="emp-location"], [class*="JobCard_location"]').text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const link = href.startsWith('http') ? href : `https://www.glassdoor.com${href}`;

      if (!title || !company) return;
      if (!isSalesRole(title)) return;

      leads.push({ title, company, location: location || 'Dubai', postedAt: new Date().toISOString(), link, source: 'Glassdoor' });
    });

    console.log(`  [${sourceName}] → ${leads.length} leads`);
    return leads;
  } catch (err) {
    console.error(`  [${sourceName}] Error: ${err.message}`);
    return [];
  }
}

async function scrapeNaukriGulf(url, sourceName) {
  try {
    await delay(1000 + Math.random() * 1000);
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const leads = [];

    $('[class*="jobTuple"], [class*="job-card"], article[class*="job"]').each((i, el) => {
      const title = $(el).find('[class*="title"], h3, h2').first().text().trim();
      const company = $(el).find('[class*="company"], [class*="employer"]').first().text().trim();
      const location = $(el).find('[class*="location"], [class*="loc"]').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const link = href.startsWith('http') ? href : `https://www.naukrigulf.com${href}`;

      if (!title || !company) return;
      if (!isSalesRole(title)) return;

      leads.push({ title, company, location: location || 'UAE', postedAt: new Date().toISOString(), link, source: 'NaukriGulf' });
    });

    console.log(`  [${sourceName}] → ${leads.length} leads`);
    return leads;
  } catch (err) {
    console.error(`  [${sourceName}] Error: ${err.message}`);
    return [];
  }
}

async function scrapeGulfTalent(url, sourceName) {
  try {
    await delay(1000 + Math.random() * 1000);
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const leads = [];

    $('[class*="job"], article, .listing').each((i, el) => {
      const title = $(el).find('h2, h3, [class*="title"]').first().text().trim();
      const company = $(el).find('[class*="company"], [class*="employer"]').first().text().trim();
      const location = $(el).find('[class*="location"], [class*="loc"]').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const link = href.startsWith('http') ? href : `https://www.gulftalent.com${href}`;

      if (!title || !company || title.length < 5) return;
      if (!isSalesRole(title)) return;

      leads.push({ title, company, location: location || 'UAE', postedAt: new Date().toISOString(), link, source: 'GulfTalent' });
    });

    console.log(`  [${sourceName}] → ${leads.length} leads`);
    return leads;
  } catch (err) {
    console.error(`  [${sourceName}] Error: ${err.message}`);
    return [];
  }
}

async function scrapeWuzzuf(url, sourceName) {
  try {
    await delay(1000 + Math.random() * 1000);
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': randomUA(), 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 15000
    });
    const $ = cheerio.load(data);
    const leads = [];

    $('[class*="job-card"], article[class*="job"], [data-id]').each((i, el) => {
      const title = $(el).find('h2, h3, [class*="title"]').first().text().trim();
      const company = $(el).find('[class*="company"]').first().text().trim();
      const location = $(el).find('[class*="location"], [class*="city"]').first().text().trim();
      const href = $(el).find('a').first().attr('href') || '';
      const link = href.startsWith('http') ? href : `https://wuzzuf.net${href}`;

      if (!title || !company || title.length < 5) return;
      if (!isSalesRole(title)) return;

      leads.push({ title, company, location: location || 'Egypt', postedAt: new Date().toISOString(), link, source: 'Wuzzuf' });
    });

    console.log(`  [${sourceName}] → ${leads.length} leads`);
    return leads;
  } catch (err) {
    console.error(`  [${sourceName}] Error: ${err.message}`);
    return [];
  }
}

async function scrapeRemoteOK(url, sourceName) {
  try {
    await delay(1000 + Math.random() * 500);
    const { data } = await axios.get(url, {
      headers: { 'User-Agent': randomUA(), 'Accept': 'application/json' },
      timeout: 15000
    });
    const jobs = Array.isArray(data) ? data.slice(1) : []; // first element is metadata
    const leads = [];

    for (const job of jobs) {
      const title = job.position || '';
      const company = job.company || '';
      if (!title || !company) continue;
      if (!isSalesRole(title)) continue;

      leads.push({
        title,
        company,
        location: job.location || 'Remote',
        postedAt: job.date ? new Date(job.date * 1000).toISOString() : new Date().toISOString(),
        link: job.url || `https://remoteok.com/remote-jobs/${job.id}`,
        source: 'RemoteOK'
      });
    }

    console.log(`  [${sourceName}] → ${leads.length} leads`);
    return leads;
  } catch (err) {
    console.error(`  [${sourceName}] Error: ${err.message}`);
    return [];
  }
}

// ─── DEMO DATA ───────────────────────────────────────────────────────────────
function getDemoLeads() {
  return [
    { title: 'Sales Executive', company: 'Noon.com', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 2*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: true },
    { title: 'Business Development Manager', company: 'Careem', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 4*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: true },
    { title: 'Head of Sales', company: 'Talabat', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 6*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: false },
    { title: 'Account Executive', company: 'Property Finder', location: 'Dubai, UAE', source: 'Indeed', postedAt: new Date(Date.now() - 8*3600000).toISOString(), link: 'https://ae.indeed.com/', funded: false },
    { title: 'Sales Manager', company: 'Bayut', location: 'Dubai, UAE', source: 'Indeed', postedAt: new Date(Date.now() - 10*3600000).toISOString(), link: 'https://ae.indeed.com/', funded: false },
    { title: 'VP of Sales', company: 'Fetchr', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 12*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: true },
    { title: 'Regional Sales Manager', company: 'Souq (Amazon)', location: 'Dubai, UAE', source: 'Bayt', postedAt: new Date(Date.now() - 14*3600000).toISOString(), link: 'https://www.bayt.com/', funded: false },
    { title: 'Marketing Manager', company: 'Dubizzle', location: 'Dubai, UAE', source: 'Bayt', postedAt: new Date(Date.now() - 16*3600000).toISOString(), link: 'https://www.bayt.com/', funded: false },
    { title: 'Business Development Executive', company: 'Aramex', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 18*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: false },
    { title: 'Sales Director', company: 'Majid Al Futtaim', location: 'Dubai, UAE', source: 'Glassdoor', postedAt: new Date(Date.now() - 20*3600000).toISOString(), link: 'https://www.glassdoor.com/', funded: false },
    { title: 'Account Manager', company: 'du Telecom', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 22*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: false },
    { title: 'Sales Executive', company: 'Anghami', location: 'Beirut, Lebanon', source: 'LinkedIn', postedAt: new Date(Date.now() - 24*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: true },
    { title: 'Business Development Manager', company: 'Wamda', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 26*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: true },
    { title: 'Enterprise Sales Manager', company: 'SAP Middle East', location: 'Dubai, UAE', source: 'Indeed', postedAt: new Date(Date.now() - 30*3600000).toISOString(), link: 'https://ae.indeed.com/', funded: false },
    { title: 'Growth Manager', company: 'Kitopi', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 35*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: true },
    { title: 'Sales Manager', company: 'Emaar Properties', location: 'Dubai, UAE', source: 'Bayt', postedAt: new Date(Date.now() - 40*3600000).toISOString(), link: 'https://www.bayt.com/', funded: false },
    { title: 'Revenue Manager', company: 'Rotana Hotels', location: 'Abu Dhabi, UAE', source: 'Bayt', postedAt: new Date(Date.now() - 45*3600000).toISOString(), link: 'https://www.bayt.com/', funded: false },
    { title: 'Channel Sales Manager', company: 'Huawei UAE', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 50*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: false },
    { title: 'SDR Team Lead', company: 'Salesforce UAE', location: 'Dubai, UAE', source: 'Glassdoor', postedAt: new Date(Date.now() - 55*3600000).toISOString(), link: 'https://www.glassdoor.com/', funded: false },
    { title: 'Commercial Manager', company: 'Etisalat (e&)', location: 'Dubai, UAE', source: 'LinkedIn', postedAt: new Date(Date.now() - 60*3600000).toISOString(), link: 'https://www.linkedin.com/jobs/', funded: false }
  ];
}

// ─── SCORING & MESSAGING ─────────────────────────────────────────────────────
function scoreLead(lead) {
  let score = 0;
  const titleLower = lead.title.toLowerCase();

  if (titleLower.includes('head') || titleLower.includes('director') || titleLower.includes('vp') || titleLower.includes('chief')) score += 30;
  else if (titleLower.includes('manager') || titleLower.includes('executive') || titleLower.includes('lead')) score += 20;
  else score += 10;

  const hoursAgo = (Date.now() - new Date(lead.postedAt).getTime()) / 3600000;
  if (hoursAgo < 6) score += 40;
  else if (hoursAgo < 24) score += 30;
  else if (hoursAgo < 48) score += 20;
  else if (hoursAgo < 72) score += 10;

  if (lead.source === 'LinkedIn') score += 10;
  else if (lead.source === 'Glassdoor') score += 8;

  if (lead.funded) score += 25;

  if (titleLower.includes('enterprise') || titleLower.includes('strategic')) score += 10;
  if (titleLower.includes('regional') || titleLower.includes('head')) score += 5;

  if (score >= 60) lead.heat = 'Hot';
  else if (score >= 35) lead.heat = 'Warm';
  else lead.heat = 'Cold';

  lead.score = score;
  return lead;
}

function generateMessage(lead) {
  const templates = {
    Hot: `Hi — saw that ${lead.company} is actively hiring a ${lead.title} in ${lead.location}. We place pre-vetted Sales & Marketing talent in 72 hours, at 10% of annual salary. Lebanese professionals — multilingual, commercially sharp, and up to 50% more cost-effective than local hires. Would a quick call make sense this week?`,
    Warm: `Hi — noticed ${lead.company} is looking for a ${lead.title}. We specialise in Sales & Marketing placement across Dubai and Lebanon — pre-vetted shortlist in 72 hours, 10% placement fee. Worth a conversation?`,
    Cold: `Hi — we help companies in ${lead.location} hire Sales and Marketing talent in 72 hours. Seeing ${lead.company} is hiring — happy to share how we work if it's useful.`
  };
  return templates[lead.heat] || templates.Warm;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function runScraper() {
  console.log('🔍 Starting Kinleague Lead Engine...\n');
  let allLeads = [];
  let liveCount = 0;

  for (const target of SEARCH_TARGETS) {
    console.log(`Scraping ${target.name}...`);
    let leads = [];
    if (target.type === 'linkedin') leads = await scrapeLinkedIn(target.url, target.name);
    else if (target.type === 'indeed') leads = await scrapeIndeed(target.url, target.name);
    else if (target.type === 'bayt') leads = await scrapeBayt(target.url, target.name);
    else if (target.type === 'glassdoor') leads = await scrapeGlassdoor(target.url, target.name);
    else if (target.type === 'naukrigulf') leads = await scrapeNaukriGulf(target.url, target.name);
    else if (target.type === 'gulftalent') leads = await scrapeGulfTalent(target.url, target.name);
    else if (target.type === 'wuzzuf') leads = await scrapeWuzzuf(target.url, target.name);
    else if (target.type === 'remoteok') leads = await scrapeRemoteOK(target.url, target.name);
    liveCount += leads.length;
    allLeads = [...allLeads, ...leads];
  }

  // Supplement with demo if not enough live results
  if (liveCount < 5) {
    console.log('\n⚠  Live scraping returned few results (sites may be blocking bots).');
    console.log('   Supplementing with realistic demo leads...\n');
    allLeads = [...allLeads, ...getDemoLeads()];
  }

  // Deduplicate
  const seen = new Set();
  allLeads = allLeads.filter(l => {
    const key = `${l.company}|${l.title}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Score and generate messages first
  allLeads = allLeads.map(lead => {
    lead = scoreLead(lead);
    lead.message = generateMessage(lead);
    lead.id = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    lead.status = 'new';
    lead.scrapedAt = new Date().toISOString();
    return lead;
  });

  // Contact enrichment (parallel batches of 3 to avoid overwhelming)
  console.log('\n📧 Enriching contact info...');
  const batchSize = 3;
  for (let i = 0; i < allLeads.length; i += batchSize) {
    const batch = allLeads.slice(i, i + batchSize);
    await Promise.all(batch.map(lead => enrichContactInfo(lead)));
  }
  const withEmail = allLeads.filter(l => l.contactEmail).length;
  console.log(`   Found emails for ${withEmail} leads`);

  // Sort by score
  allLeads.sort((a, b) => b.score - a.score);

  // Save JSON
  const outPath = path.join(__dirname, '..', 'leads.json');
  fs.writeFileSync(outPath, JSON.stringify(allLeads, null, 2));

  // Save CSV
  const csv = [
    'Company,Title,Location,Source,Heat,Score,Posted,Link,Email,Phone,Message',
    ...allLeads.map(l =>
      `"${l.company}","${l.title}","${l.location}","${l.source}","${l.heat}","${l.score}","${l.postedAt}","${l.link||''}","${l.contactEmail||''}","${l.contactPhone||''}","${(l.message||'').replace(/"/g, "'")}"`
    )
  ].join('\n');
  const csvPath = path.join(__dirname, '..', 'leads.csv');
  fs.writeFileSync(csvPath, csv);

  console.log(`\n✅ Done. ${allLeads.length} leads saved.`);
  console.log(`   🔥 Hot:  ${allLeads.filter(l => l.heat === 'Hot').length}`);
  console.log(`   ♨  Warm: ${allLeads.filter(l => l.heat === 'Warm').length}`);
  console.log(`   🔵 Cold: ${allLeads.filter(l => l.heat === 'Cold').length}`);
  console.log(`   📧 Email: ${withEmail}`);

  return allLeads;
}

runScraper();
