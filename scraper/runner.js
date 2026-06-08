'use strict';
const { runScrapeAndPush } = require('./engine');

const FULL_SCRAPE_INTERVAL = 15 * 60 * 1000;
let runCount = 0;
let lastFullScrape = 0;
let isRunning = false;

async function tick() {
  if (isRunning) return;
  const now = Date.now();
  if (now - lastFullScrape < FULL_SCRAPE_INTERVAL) {
    const sec = Math.ceil((FULL_SCRAPE_INTERVAL - (now - lastFullScrape)) / 1000);
    console.log(`[runner] Next scrape in ${sec}s`);
    return;
  }
  isRunning = true;
  runCount++;
  lastFullScrape = now;
  try {
    console.log(`\n[runner] Run #${runCount} at ${new Date().toISOString()}`);
    const state = await runScrapeAndPush();
    console.log(`[runner] Done. ${state.newThisRun} new, ${state.pushedThisRun} pushed`);
  } catch(e) { console.error('[runner] Failed:', e.message); }
  finally { isRunning = false; }
}

console.log('=======================================');
console.log('  KINLEAGUE LEAD ENGINE — CONTINUOUS  ');
console.log('=======================================');
console.log('Scraping every 15 minutes | UAE · USA · Lebanon\n');

tick();
setInterval(tick, 60000);
process.on('SIGINT', () => { console.log('\n[runner] Stopped.'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
