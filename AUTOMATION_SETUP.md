# Kinleague Lead Engine — 24/7 Automation Setup

## How it works

| Trigger | Frequency | What it does |
|---|---|---|
| GitHub Actions | Every 2 hours | Scrapes all 9 platforms, enriches contacts, auto-pushes hot leads with email to CRM |
| Vercel Crons | 6× daily (every 4h) | Backup scrape, updates dashboard data |
| Manual button | On demand | Immediate scrape from the dashboard |

## GitHub Actions Setup (one-time, 5 minutes)

### 1. Create a GitHub repo
```bash
cd /Users/mac/Downloads/kinleague-lead-engine
git remote add origin https://github.com/YOUR_USERNAME/kinleague-lead-engine
git push -u origin main
```

### 2. Enable Actions
- Go to your repo on github.com
- Click **Actions** tab
- Click **Enable workflows**

### 3. Test it manually
- Go to Actions → **Kinleague Lead Scraper** → **Run workflow** → Run
- Watch it run live — takes ~5 minutes
- Check the **Summary** tab to see hot leads found

### 4. It now runs automatically every 2 hours
- Hot leads with emails get auto-pushed to app.kinleague.com CRM
- leads.json is committed back to the repo after each run
- Artifacts (leads.json + leads.csv) saved for 7 days per run

## Free tier usage

| Service | Free limit | Your usage | Status |
|---|---|---|---|
| GitHub Actions | 2,000 min/month | ~1,800 min/month (12 runs/day × 5min) | ✅ Within limit |
| Vercel Crons | 12/day | 6/day | ✅ Within limit |
| Supabase | 500MB | Minimal | ✅ Fine |

## Vercel Crons (already configured)

Runs at: 2am, 6am, 10am, 2pm, 6pm, 10pm UTC
View logs: vercel.com → your project → Logs → Cron

## What you wake up to every morning

- CRM (`app.kinleague.com → Website Leads`) populated with overnight hot leads
- Each lead has: company name, role, location, heat score, suggested outreach message
- Filter by `source = lead_engine_auto` to see auto-pushed leads
