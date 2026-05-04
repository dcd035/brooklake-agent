# Brooklake Agent — Railway Deployment Guide

This is a small Node.js service that runs a headless Chrome browser to book tee times at Brooklake CC. It receives booking details from n8n, logs in, fills the form, and returns a confirmation. Credentials are passed per-request and never stored.

---

## Files in this folder

| File | Purpose |
|---|---|
| `server.js` | The booking agent service |
| `package.json` | Node.js dependencies |
| `railway.toml` | Railway deployment config |
| `.gitignore` | Keeps node_modules out of Git |

---

## Step 1 — Create a GitHub repository

1. Go to [github.com](https://github.com) and sign in
2. Click the **+** button (top right) → **New repository**
3. Name it `brooklake-agent`
4. Leave it **Private**
5. Do NOT check "Add README" (you already have these files)
6. Click **Create repository**
7. GitHub will show you a page with setup commands — keep this tab open

---

## Step 2 — Push these files to GitHub

Open **Terminal** (Mac) or **Command Prompt** / **PowerShell** (Windows) and run these commands one at a time:

```bash
cd ~/Downloads/brooklake-agent
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/brooklake-agent.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username (visible on the GitHub page from Step 1).

---

## Step 3 — Create a Railway account and deploy

1. Go to [railway.app](https://railway.app) and click **Login** → **Login with GitHub**
2. Authorize Railway to access your GitHub account
3. On the Railway dashboard, click **New Project**
4. Click **Deploy from GitHub repo**
5. Find and select `brooklake-agent`
6. Railway will automatically detect it's a Node.js app and start deploying

The first deploy takes about **3–4 minutes** because it has to install Chromium. You'll see a build log — it's done when you see "brooklake-agent running on port 3000".

---

## Step 4 — Get your Railway service URL

1. In your Railway project, click on the service (the box labeled `brooklake-agent`)
2. Click the **Settings** tab
3. Under **Networking**, click **Generate Domain**
4. Railway gives you a URL like `https://brooklake-agent-production-xxxx.up.railway.app`
5. Copy this URL — you'll need it in n8n

To verify it's working, open a browser and go to:
```
https://YOUR_RAILWAY_URL/health
```
You should see: `{"status":"ok","service":"brooklake-agent"}`

---

## Step 5 — Update n8n

In your n8n workflow, the **Book: Call Railway Agent** node needs:

- **URL**: `https://YOUR_RAILWAY_URL/book`
- **Method**: POST
- **Body**: JSON (already configured — see workflow)

The node passes your Brooklake credentials and booking details to the Railway service. The service never stores them.

---

## Notes

- **Free tier**: Railway's Hobby plan gives $5/month free credit. This service uses roughly $0.10–0.20/month at once-or-twice-weekly usage — well within the free tier.
- **Sleep**: Railway may put the service to sleep after inactivity. The first booking after a long idle period may take 30–60 seconds for the service to wake up. Subsequent bookings are fast.
- **Logs**: In Railway, click your service → **Deployments** tab → click a deployment → **View Logs** to see exactly what happened during a booking.
- **Re-deploying**: If you ever update `server.js`, just `git add . && git commit -m "update" && git push` and Railway auto-deploys.
