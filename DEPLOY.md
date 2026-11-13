# Publishing own downloader — GitHub + Supabase + Vercel + Railway

This guide takes the app from your PC to the public internet.

**Architecture** (why each service):

| Piece | Service | Why |
|---|---|---|
| Web app (this `web/` folder) | **Vercel** | Static site, free, global CDN |
| Download engine (`server.js` + yt-dlp + ffmpeg) | **Railway** (Docker) | Needs a real long-running server — serverless (Vercel) can't run downloads |
| Accounts, history, roles | **Supabase** | Free Postgres + Auth + Row Level Security |

**Data design (as requested):**
- Video files are **never** stored in any database or cloud. They stream directly from the engine to the user's device, then the server copy is deleted instantly.
- Only download-history **links/metadata** are stored.
- Guests: history lives in their browser only, auto-clears after **24 hours**.
- Optional accounts: history stored per-user in Supabase, visible only to them.
- Admins: dashboard at `/admin.html` to manage users and history.

---

## 1. Supabase setup (~5 min)

1. Go to [supabase.com](https://supabase.com) → **New project** (pick a region near your users).
2. Open **SQL Editor** → paste the whole contents of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   - Creates `profiles`, `downloads`, triggers, and Row Level Security policies.
3. Go to **Authentication → Providers → Email**: turn *ON* "Confirm email" (recommended) — users can also register without confirming if you turn it off (no-verification = easier signup).
4. Collect three values (Settings → API):
   - `Project URL` → SUPABASE_URL
   - `anon public` key → SUPABASE_ANON_KEY (goes in the frontend config)
   - `service_role` key → kept **secret**, goes only in Railway env vars

## 2. Download engine on Railway (~10 min)

1. Push this repo to GitHub (below), then on [railway.com](https://railway.com):
   **New Project → Deploy from GitHub repo** → select this repo.
2. Railway auto-detects the `Dockerfile` (Python + yt-dlp + ffmpeg + Node). Set these **variables**:

   | Variable | Value |
   |---|---|
   | `MODE` | `public` |
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | your service_role key (**secret**) |
   | `ALLOWED_ORIGIN` | your Vercel URL (e.g. `https://your-app.vercel.app`) |

3. **Settings → Networking → Generate Domain** → note the URL, e.g. `https://own-downloader-api.up.railway.app`

## 3. Frontend on Vercel (~5 min)

1. [vercel.com](https://vercel.com) → **Add New → Project** → import the same GitHub repo.
2. **Root Directory**: set to `web`.
3. Framework preset: **Other** (it's a static site — no build step).
4. Deploy. Note your URL.

## 4. Connect the two

Edit `web/config.js` in the repo and commit:

```js
const CONFIG = {
  API_URL: "https://own-downloader-api.up.railway.app",   // Railway URL
  SUPABASE_URL: "https://abcdefgh.supabase.co",           // Supabase Project URL
  SUPABASE_ANON_KEY: "eyJ...",                            // anon public key
};
```

Redeploy Vercel (commit push = auto deploy). Also update Railway's `ALLOWED_ORIGIN` to your final Vercel URL.

## 5. Make yourself admin

1. Open the site → **Sign in → Create account** with your own email.
2. Supabase → **SQL Editor** → run:
   ```sql
   update public.profiles set role = 'admin' where id = (
     select id from auth.users where email = 'your@email.com'
   );
   ```
3. Refresh the site — you'll now see the **Admin** button → `/admin.html`:
   - list users, promote/demote admins, delete users
   - view/delete all download history

---

## Pushing to GitHub

```bash
git init
git add .
git commit -m "own downloader v2 — public deployment"
# create an empty repo on github.com first, then:
git remote add origin https://github.com/YOUR-USERNAME/own-downloader.git
git branch -M main
git push -u origin main
```

## Local use (unchanged)

```bash
npm start        # MODE=local by default → http://localhost:3000
```

Local mode keeps everything from before: files land in `downloads/`, "open folder" works, no accounts needed. The same frontend detects the mode automatically.

## Costs

| Service | Free tier covers |
|---|---|
| Vercel | hobby: plenty for a static frontend |
| Supabase | 500 MB DB, 50k auth users |
| Railway | $5 trial credit; ~$5/mo after — the engine is the only real cost |

## Known limits & notes

- **YouTube on cloud IPs**: YouTube aggressively challenges datacenter IPs ("confirm you're not a bot"). If downloads start failing on Railway, options: residential proxy env vars (`YTDL_PROXY`), or cookies. TikTok/IG/FB are usually fine. Keep yt-dlp updated in the Dockerfile.
- Rate limits built in: max 3 concurrent downloads server-wide, 20 downloads/hour per IP (guests).
- Temp files are deleted immediately after streaming; an hourly sweep cleans orphans.
- Respect copyright: the app is for content the user has the right to download.
