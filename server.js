/**
 * own downloader — multi-platform video downloader
 * YouTube / TikTok / Instagram / Facebook
 *
 * Two modes:
 *   MODE=local  (default) — files saved to ./downloads, explorer integration
 *   MODE=public           — files stream straight to the user's browser and are
 *                           deleted from the server afterwards. History is
 *                           metadata-only (links) in Supabase; nothing persists.
 *
 * Download engine: yt-dlp (+ ffmpeg for merging)
 */

const express = require("express");
const cors = require("cors");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const MODE = (process.env.MODE || "local").toLowerCase(); // "local" | "public"
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "web")));

/* In public mode the API is called from the Vercel-hosted frontend */
if (MODE === "public") {
  // ALLOWED_ORIGIN may be a comma-separated list of allowed frontend origins
  const origins = (process.env.ALLOWED_ORIGIN || "*").split(",").map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins.includes("*") ? "*" : origins, credentials: false }));
}

/* ------------------------------------------------------------------ */
/* Zotomic access control (public mode only).                          */
/* Set API_KEY + TICKET_SECRET env vars to lock the engine down:       */
/*   - /api/info, /api/download, /api/tts, /api/tts/voices require     */
/*     the X-API-Key header (Zotomic's server holds the key).          */
/*   - /api/progress/:id and /api/file/:id accept either the API key   */
/*     or a short-lived signed ticket (?t=<exp>.<hmac>) that Zotomic   */
/*     issues per download job, so the user's browser can fetch the    */
/*     file directly without the key ever leaving the server.          */
/* With neither env var set the engine stays open (previous behaviour).*/
/* ------------------------------------------------------------------ */

const API_KEY = process.env.API_KEY || "";
const TICKET_SECRET = process.env.TICKET_SECRET || "";
const KEYED_ENDPOINTS = ["/api/info", "/api/download", "/api/tts", "/api/video", "/api/pot-status"];

function validTicket(jobId, ticket) {
  if (!TICKET_SECRET || !ticket) return false;
  const [expRaw, mac] = String(ticket).split(".");
  const exp = Number(expRaw);
  if (!exp || !mac || exp < Date.now()) return false;
  const expected = crypto
    .createHmac("sha256", TICKET_SECRET)
    .update(`${jobId}.${exp}`)
    .digest("base64url");
  try {
    return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

if (MODE === "public") {
  app.use((req, res, next) => {
    const p = req.path;
    if (p === "/api/config") return next();
    if (p.startsWith("/api/tts/voices") || KEYED_ENDPOINTS.includes(p)) {
      if (API_KEY && req.headers["x-api-key"] !== API_KEY) {
        return res.status(401).json({ error: "Unauthorized." });
      }
      return next();
    }
    if (p.startsWith("/api/progress/") || p.startsWith("/api/file/")) {
      if (API_KEY && req.headers["x-api-key"] === API_KEY) return next();
      const jobId = p.split("/")[3] || "";
      if (validTicket(jobId, req.query.t)) return next();
      return res.status(403).json({ error: "Invalid or expired ticket." });
    }
    next();
  });
}

/* ------------------------------------------------------------------ */
/* Directories                                                         */
/* ------------------------------------------------------------------ */

const LOCAL_DIR = path.join(__dirname, "downloads");
const TEMP_DIR = path.join(os.tmpdir(), "own-downloader-jobs");
if (MODE === "local") {
  if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
} else {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  setInterval(() => {
    // Safety net: purge orphaned temp files. Generated videos stay
    // downloadable for 24h; everything else for 1 hour.
    try {
      for (const f of fs.readdirSync(TEMP_DIR)) {
        const p = path.join(TEMP_DIR, f);
        const maxAge = /-generated-video\.mp4$/.test(f) ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
        if (Date.now() - fs.statSync(p).mtimeMs > maxAge) {
          fs.unlinkSync(p);
          const m = /^([0-9a-f]{16})-generated-video\.mp4$/.exec(f);
          if (m) jobs.delete(m[1]);
        }
      }
    } catch {}
  }, 10 * 60 * 1000).unref();
}

/* ------------------------------------------------------------------ */
/* Job registry (in-memory)                                            */
/* ------------------------------------------------------------------ */

const jobs = new Map();
const rateHits = new Map(); // public mode: ip -> timestamps

function createJob(url) {
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, status: "starting", percent: 0, speed: "", eta: "", title: "", filename: "", error: "", url };
  jobs.set(id, job);
  return job;
}

/**
 * The job registry is in-memory, but a deploy / idle restart of the service
 * would orphan finished generated videos. Re-attach them as done jobs so the
 * download links keep working for the file's lifetime (24h, see purge below).
 */
function rebuildVideoJobs() {
  const dir = MODE === "local" ? LOCAL_DIR : TEMP_DIR;
  const re = MODE === "local" ? /^video-([0-9a-f]{16})\.mp4$/ : /^([0-9a-f]{16})-generated-video\.mp4$/;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = re.exec(f);
      if (!m || jobs.has(m[1])) continue;
      try {
        const st = fs.statSync(path.join(dir, f));
        if (!st.isFile() || st.size < 10_000) continue;
        const job = createJob("");
        job.kind = "video";
        job.status = "done";
        job.percent = 100;
        job.title = "Generated video";
        job.filepath = path.join(dir, f);
        job.filename = f;
        job.size = st.size;
        job.note = "";
      } catch {}
    }
  } catch {}
}
rebuildVideoJobs();

/* ------------------------------------------------------------------ */
/* URL validation                                                      */
/* ------------------------------------------------------------------ */

const ALLOWED_HOSTS = [
  "youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be", "music.youtube.com",
  "tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com",
  "instagram.com", "www.instagram.com",
  "facebook.com", "www.facebook.com", "m.facebook.com", "fb.watch", "web.facebook.com",
];

function isAllowedUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return ALLOWED_HOSTS.includes(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* yt-dlp helpers                                                      */
/* ------------------------------------------------------------------ */

function ytdlpArgs(extra = []) {
  // node must be explicitly enabled as the JS runtime for YouTube's
  // n-challenge solving (deno is default-enabled, node is not)
  return ["-m", "yt_dlp", "--js-runtimes", "node", ...extra];
}

/* YouTube sometimes serves degraded responses to cloud IPs.
 * Retrying with alternative player clients usually recovers.
 * With login cookies the working combination (Nov 2026) is
 * web_safari/web_embedded + the ejs n-challenge solver + PO tokens,
 * and tv_downgraded excluded (yt-dlp bug #17389). */
const YT_CLIENTS_NO_COOKIES = ["default", "tv", "android_vr", "mweb", "tv,web_safari,mweb"];
const YT_CLIENTS_WITH_COOKIES = ["web_safari,web_embedded,-tv_downgraded", "default,-tv_downgraded", "mweb"];
function ytClients() {
  return process.env.YTDLP_COOKIES ? YT_CLIENTS_WITH_COOKIES : YT_CLIENTS_NO_COOKIES;
}
function ytFallbacks() {
  return ytClients().map((c) => ["--extractor-args", `youtube:player_client=${c}`]);
}

/* Optional login cookies (env var YTDLP_COOKIES, Netscape format) —
 * set via the hosting dashboard, never stored in code */
function cookiesArgs() {
  const raw = process.env.YTDLP_COOKIES;
  if (!raw) return [];
  const file = path.join(os.tmpdir(), "ytdlp-cookies.txt");
  try {
    fs.writeFileSync(file, raw.replace(/\\n/g, "\n"), { flag: "w" });
    return ["--cookies", file];
  } catch {
    return [];
  }
}

/* Optional outbound proxy (env var YTDLP_PROXY, e.g. http://user:pass@host:port)
 * — routes yt-dlp traffic through a residential/ISP proxy to avoid
 * datacenter IP bot checks. */
function proxyArgs() {
  const proxy = process.env.YTDLP_PROXY;
  return proxy ? ["--proxy", proxy] : [];
}

async function fetchVideoInfo(url) {
  let lastErr;
  const fallbacks = ytFallbacks();
  for (const fallback of fallbacks) {
    try {
      return await runYtDlp([
        "-J", "--no-warnings", "--no-playlist", "--socket-timeout", "15",
        ...proxyArgs(),
        ...cookiesArgs(),
        ...fallback,
        url,
      ]);
    } catch (err) {
      lastErr = err;
      // Auth/geo/private errors won't be fixed by retrying with another client
      const m = String(err.message || err).toLowerCase();
      if (m.includes("private") || m.includes("geo") || m.includes("country") || m.includes("age")) break;
    }
  }
  throw lastErr;
}

function spawnYtDlp(args) {
  return spawn("python", ytdlpArgs(args), { windowsHide: true });
}

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawnYtDlp(args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => { stdout += c.toString(); });
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
    });
  });
}

function detectPlatform(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (host.includes("youtu")) return "YouTube";
  if (host.includes("tiktok")) return "TikTok";
  if (host.includes("instagram")) return "Instagram";
  if (host.includes("facebook") || host === "fb.watch") return "Facebook";
  return "Unknown";
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function friendlyError(msg, url) {
  const m = msg.toLowerCase();
  if (m.includes("sign in to confirm") || m.includes("not a bot")) {
    return "YouTube is asking this server to prove it's not a bot for this video. Please try again in a minute or pick a different quality/link.";
  }
  if (m.includes("not available") || m.includes("video unavailable") || m.includes("unavailable") || m.includes("removed")) {
    return "This video can't be fetched from this server — it may be deleted, private, region-locked, or the platform is restricting the server's IP. Please try again in a minute, or try a different link.";
  }
  if (m.includes("does not exist") || m.includes("not exist") || m.includes("invalid video id")) {
    return "That video doesn't exist. Double-check the link.";
  }
  if (m.includes("private") || m.includes("login required") || m.includes("rate-limit") || m.includes("cookies")) {
    return "This content is private or requires login. Public posts work; private ones cannot be downloaded.";
  }
  if (m.includes("age") && (m.includes("restrict") || m.includes("confirm"))) {
    return "This video is age-restricted and can't be downloaded anonymously.";
  }
  if (m.includes("not a valid url") || m.includes("unsupported url")) {
    return "That link doesn't look like a supported video URL.";
  }
  if (m.includes("geo") || m.includes("country")) {
    return "This video is blocked in your country/region.";
  }
  if (m.includes("timed out") || m.includes("timeout")) {
    return "The request timed out. Please try again.";
  }
  console.error(`[error] ${url}: ${msg}`);
  return "Could not process this link. Check the URL and try again.";
}

/* ------------------------------------------------------------------ */
/* API: config (tells the frontend which mode it's in)                 */
/* ------------------------------------------------------------------ */

app.get("/api/config", (req, res) => {
  res.json({ mode: MODE });
});

/* API: PO-token provider status (diagnostics, API-key protected) */
app.get("/api/pot-status", async (req, res) => {
  const provider = await checkPotProvider();
  res.json({
    provider,
    providerBuilt: fs.existsSync(BGUTIL_SERVER),
    cookies: Boolean(process.env.YTDLP_COOKIES),
    proxy: Boolean(process.env.YTDLP_PROXY),
    clients: ytClients(),
  });
});

/* ------------------------------------------------------------------ */
/* API: fetch video info                                               */
/* ------------------------------------------------------------------ */

app.post("/api/info", async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isAllowedUrl(url)) {
    return res.status(400).json({ error: "Please enter a valid YouTube, TikTok, Instagram or Facebook URL." });
  }

  try {
    const raw = await fetchVideoInfo(url);
    const info = JSON.parse(raw);
    const platform = detectPlatform(url);

    const qualities = new Map();
    for (const f of info.formats || []) {
      if (f.vcodec && f.vcodec !== "none" && f.height) {
        const h = f.height;
        if (!qualities.has(h) || (f.tbr || 0) > (qualities.get(h).tbr || 0)) {
          qualities.set(h, { height: h, fps: f.fps || null, tbr: f.tbr || 0 });
        }
      }
    }

    const heights = [...qualities.keys()].sort((a, b) => b - a);
    const options = [];
    for (const h of heights) {
      const fps = qualities.get(h).fps;
      options.push({ id: `h${h}`, label: `${h}p${fps && fps > 30 ? fps : ""}` });
      if (options.length >= 8) break;
    }
    options.push({ id: "best", label: "Best available" });

    res.json({
      platform,
      title: info.title || "Untitled",
      uploader: info.uploader || info.channel || info.uploader_id || "",
      duration: formatDuration(info.duration),
      thumbnail: info.thumbnail || "",
      viewCount: info.view_count || null,
      isLive: !!info.is_live,
      qualities: options,
    });
  } catch (err) {
    const detail = String(err.message || err).trim().split("\n").slice(-6).join("\n").slice(0, 700);
    console.error(`[info] ${url}: ${detail}`);
    res.status(500).json({ error: friendlyError(String(err.message || err), url), detail });
  }
});

/* ------------------------------------------------------------------ */
/* API: start download job                                             */
/* ------------------------------------------------------------------ */

function startJob(url, mode, qualityId) {
  let format = "bv*+ba/b";
  if (mode === "video" && qualityId && qualityId !== "best") {
    const m = /^h(\d+)$/.exec(qualityId);
    if (m) format = `bv*[height<=${m[1]}]+ba/b[height<=${m[1]}]`;
  }

  const job = createJob(url);
  // Public mode: prefix the temp filename with the job id so concurrent
  // downloads can never be mixed up; local mode keeps the clean name.
  const fileTemplate = MODE === "local"
    ? "%(title).80s-%(id)s.%(ext)s"
    : `${job.id}-%(title).80s.%(ext)s`;
  const outDir = MODE === "local" ? LOCAL_DIR : TEMP_DIR;

  const baseArgs = [
    "--newline", "--no-warnings", "--no-playlist", "--restrict-filenames", "--no-mtime",
    "-o", path.join(outDir, fileTemplate),
    "--print", "after_move:filepath",
    "--no-simulate",
    "-f", mode === "audio" ? "bestaudio/best" : format,
  ];

  if (mode === "audio") {
    baseArgs.push("-x", "--audio-format", "mp3", "--audio-quality", "0");
  } else {
    baseArgs.push("--merge-output-format", "mp4", "-S", "ext:mp4:m4a");
  }

  const isYT = /youtube|youtu\.be/i.test(url);
  const clients = isYT ? ytClients() : [null];
  let attempt = 0;
  let proc = null;
  let stdoutBuf = "";
  let stderrMsg = "";

  const resolveFile = () => {
    if (!job.filename) {
      try {
        let files = fs.readdirSync(outDir)
          .map((f) => ({ f, t: fs.statSync(path.join(outDir, f)).mtimeMs }))
          .sort((a, b) => b.t - a.t);
        if (MODE === "public") files = files.filter((x) => x.f.startsWith(`${job.id}-`));
        if (files[0]) job.filename = files[0].f;
      } catch {}
    }
    const resolved = path.join(outDir, path.basename(job.filename || ""));
    if (fs.existsSync(resolved)) {
      job.filepath = resolved;
      job.size = fs.statSync(resolved).size;
    }
  };

  const finishError = (msg) => {
    job.status = "error";
    job.error = msg;
  };

  /* YouTube bot-check errors are worth one more shot with a different
   * player client; everything else (private/geo/removed) is not. */
  const isRetryable = (msg) => {
    const m = msg.toLowerCase();
    return (
      m.includes("sign in to confirm") ||
      m.includes("not a bot") ||
      m.includes("player client") ||
      m.includes("precondition check failed") ||
      m.includes("requested format")
    );
  };

  const handleLine = (line) => {
    const prog = /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\w+)(?:\s+at\s+([\d.]+\w+\/s))?(?:\s+ETA\s+(\S+))?/.exec(line);
    if (prog) {
      job.status = "downloading";
      job.percent = parseFloat(prog[1]);
      job.speed = prog[3] || "";
      job.eta = prog[4] || "";
      return;
    }
    const dest = /\[download\] Destination: (.+)/.exec(line);
    if (dest && !job.title) job.filename = path.basename(dest[1]).replace(/\.[^.]+$/, "");
    const merger = /\[Merger\] Destination: (.+)/.exec(line) || /\[ExtractAudio\] Destination: (.+)/.exec(line);
    if (merger) job.filename = path.basename(merger[1]);
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("[") && fs.existsSync(trimmed)) {
      job.filename = path.basename(trimmed);
    }
  };

  const launch = () => {
    const args = [...baseArgs];
    if (clients[attempt]) args.push("--extractor-args", `youtube:player_client=${clients[attempt]}`);
    args.push(...proxyArgs(), ...cookiesArgs(), url);

    stderrMsg = "";
    stdoutBuf = "";
    job.filename = "";
    proc = spawnYtDlp(args);
    job.proc = proc;
    job.status = "downloading";
    if (attempt > 0) job.note = `retrying with YouTube player client: ${clients[attempt]}`;

    proc.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const parts = stdoutBuf.split(/\r?\n/);
      stdoutBuf = parts.pop();
      parts.forEach((l) => l && handleLine(l));
    });

    proc.stderr.on("data", (c) => { stderrMsg += c.toString(); });

    proc.on("error", (err) => {
      finishError(String(err.message || err));
    });

    proc.on("close", (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
      if (code === 0) {
        job.status = "done";
        job.percent = 100;
        resolveFile();
      } else {
        const lastErr = stderrMsg.trim().split("\n").slice(-3).join("\n") || `yt-dlp exited with code ${code}`;
        if (attempt < clients.length - 1 && isRetryable(lastErr)) {
          attempt += 1;
          launch();
        } else {
          const tag = clients[attempt] && isYT ? ` [player client: ${clients[attempt]}]` : "";
          finishError(lastErr + tag);
        }
      }
    });
  };

  launch();
  return job;
}

app.post("/api/download", (req, res) => {
  const { url, mode = "video", qualityId } = req.body || {};
  if (!url || !isAllowedUrl(url)) return res.status(400).json({ error: "Invalid URL." });
  if (mode !== "video" && mode !== "audio") return res.status(400).json({ error: "Invalid mode." });

  const activeCount = [...jobs.values()].filter(
    (j) => (j.status === "downloading" || j.status === "starting")
  ).length;
  if (activeCount >= 3) {
    return res.status(429).json({ error: "Server is busy right now — please try again in a moment." });
  }

  // Light per-IP rate limit in public mode (20 downloads / hour)
  if (MODE === "public") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const now = Date.now();
    const windowMs = 60 * 60 * 1000;
    const hits = (rateHits.get(ip) || []).filter((t) => now - t < windowMs);
    if (hits.length >= 20) {
      return res.status(429).json({ error: "Too many downloads from your network — try again later." });
    }
    hits.push(now);
    rateHits.set(ip, hits);
  }

  const job = startJob(url, mode, qualityId);
  res.json({ jobId: job.id });
});

/* ------------------------------------------------------------------ */
/* API: job progress                                                   */
/* ------------------------------------------------------------------ */

app.get("/api/progress/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  const { proc, filepath, ...safe } = job;
  res.json({ ...safe, hasFile: !!filepath });
});

/* ------------------------------------------------------------------ */
/* API: fetch the finished file                                        */
/*   downloader jobs: streams to the browser, then deletes the server  */
/*   copy (one-shot, nothing kept). Generated videos stay available    */
/*   for 24h so the inline preview and the Download button can both    */
/*   fetch the same URL (and retries work).                            */
/* ------------------------------------------------------------------ */

app.get("/api/file/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  if (job.status !== "done" || !job.filepath || !fs.existsSync(job.filepath)) {
    return res.status(404).json({ error: "File is no longer available." });
  }

  const safeName = (job.filename || "video.mp4").replace(/[\\/:*?"<>|]/g, "_");
  res.download(job.filepath, safeName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).end();
      return;
    }
    // Downloader files are one-shot (privacy): delete right after transfer.
    if (MODE === "public" && job.kind !== "video") {
      try { fs.unlinkSync(job.filepath); } catch {}
      jobs.delete(job.id);
    }
  });
});

/* ------------------------------------------------------------------ */
/* LOCAL MODE ONLY: folder listing + explorer integration              */
/* ------------------------------------------------------------------ */

if (MODE === "local") {
  app.get("/api/downloads", (req, res) => {
    try {
      const files = fs.readdirSync(LOCAL_DIR)
        .filter((f) => !f.startsWith("."))
        .map((f) => {
          const st = fs.statSync(path.join(LOCAL_DIR, f));
          return { name: f, size: st.size, modified: st.mtimeMs };
        })
        .sort((a, b) => b.modified - a.modified);
      res.json(files);
    } catch {
      res.json([]);
    }
  });

  app.get("/api/file-by-name/:name", (req, res) => {
    const name = path.basename(req.params.name);
    const file = path.join(LOCAL_DIR, name);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "File not found." });
    res.download(file);
  });

  app.post("/api/open-folder", (req, res) => {
    const { name } = req.body || {};
    try {
      if (name) {
        const file = path.join(LOCAL_DIR, path.basename(name));
        if (fs.existsSync(file)) {
          spawn("explorer.exe", ["/select,", file], { detached: true, stdio: "ignore" }).unref();
          return res.json({ ok: true });
        }
      }
      spawn("explorer.exe", [LOCAL_DIR], { detached: true, stdio: "ignore" }).unref();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });
}

/* ------------------------------------------------------------------ */
/* PUBLIC MODE ONLY: admin endpoints (require an admin JWT)            */
/* ------------------------------------------------------------------ */

let supabaseAdmin = null;
function getSupabaseAdmin() {
  if (MODE !== "public") return null;
  if (!supabaseAdmin) {
    const { createClient } = require("@supabase/supabase-js");
    supabaseAdmin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
  }
  return supabaseAdmin;
}

async function requireAdmin(req, res) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ error: "Not signed in." }); return null; }

  const sb = getSupabaseAdmin();
  if (!sb) { res.status(501).json({ error: "Supabase not configured." }); return null; }

  const { data: userData, error } = await sb.auth.getUser(token);
  if (error || !userData?.user) { res.status(401).json({ error: "Invalid session." }); return null; }

  const { data: profile } = await sb.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (profile?.role !== "admin") { res.status(403).json({ error: "Admin access required." }); return null; }

  return { sb, userId: userData.user.id, email: userData.user.email };
}

/* List all users (from Supabase auth) + their history counts */
app.get("/api/admin/users", async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const { data, error } = await ctx.sb.auth.admin.listUsers({ perPage: 200 });
  if (error) return res.status(500).json({ error: error.message });

  const users = [];
  for (const u of data.users) {
    const { count } = await ctx.sb.from("downloads").select("*", { count: "exact", head: true }).eq("user_id", u.id);
    const { data: prof } = await ctx.sb.from("profiles").select("role, created_at").eq("id", u.id).maybeSingle();
    users.push({
      id: u.id,
      email: u.email || "(no email)",
      name: u.user_metadata?.name || "",
      role: prof?.role || "user",
      createdAt: prof?.created_at || u.created_at,
      lastSignIn: u.last_sign_in_at || null,
      downloads: count || 0,
    });
  }
  res.json(users);
});

/* Create a user (admin adds an account manually) */
app.post("/api/admin/users", async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const { email, password, role = "user", name = "" } = req.body || {};
  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "Email and a password (min 6 chars) are required." });
  }
  const { data, error } = await ctx.sb.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: name ? { name } : undefined,
  });
  if (error) return res.status(500).json({ error: error.message });

  if (role === "admin" || role === "user") {
    await ctx.sb.from("profiles").upsert({ id: data.user.id, role });
  }
  res.json({ ok: true, id: data.user.id });
});

/* Edit a user (email / password / role) */
app.put("/api/admin/users/:id", async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const { email, password, role, name } = req.body || {};

  const attrs = {};
  if (email) attrs.email = email;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    attrs.password = password;
  }
  if (name !== undefined) attrs.user_metadata = { name };
  if (Object.keys(attrs).length) {
    const { error } = await ctx.sb.auth.admin.updateUserById(req.params.id, attrs);
    if (error) return res.status(500).json({ error: error.message });
  }
  if (role === "admin" || role === "user") {
    const { error } = await ctx.sb.from("profiles").update({ role }).eq("id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

/* Delete a user (auth + profile cascade + their history) */
app.delete("/api/admin/users/:id", async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  if (req.params.id === ctx.userId) return res.status(400).json({ error: "You cannot delete your own account." });
  const { error } = await ctx.sb.auth.admin.deleteUser(req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* Promote / demote a user */
app.put("/api/admin/users/:id/role", async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const role = req.body?.role === "admin" ? "admin" : "user";
  const { error } = await ctx.sb.from("profiles").update({ role }).eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, role });
});

/* All download-history rows (links only — no files) */
app.get("/api/admin/downloads", async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const { data, error } = await ctx.sb
    .from("downloads")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.delete("/api/admin/downloads/:id", async (req, res) => {
  const ctx = await requireAdmin(req, res);
  if (!ctx) return;
  const { error } = await ctx.sb.from("downloads").delete().eq("id", req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* API: text-to-speech (edge-tts — free neural voices)                 */
/* ------------------------------------------------------------------ */

let voiceCache = null; // fetched once, then kept in memory

app.get("/api/tts/voices", async (req, res) => {
  try {
    if (!voiceCache) {
      const { spawnSync } = require("child_process");
      const out = spawnSync("python", ["-m", "edge_tts", "--list-voices"], { windowsHide: true, timeout: 30000 });
      if (out.status !== 0) throw new Error(out.stderr.toString() || "edge-tts failed");
      const voices = [];
      for (const line of out.stdout.toString().split(/\r?\n/)) {
        const cols = line.trim().split(/\s{2,}/); // table columns separated by 2+ spaces
        if (cols.length < 2) continue;
        const name = cols[0];
        // Voice names look like: en-US-GuyNeural, af-ZA-AdriNeural …
        const localeMatch = /^([a-z]{2,3}-[A-Za-z0-9]{2,8})-/.exec(name);
        if (!localeMatch || name.startsWith("Name")) continue;
        voices.push({
          id: name,
          gender: (cols[1] || "").toLowerCase(),
          locale: localeMatch[1],
        });
      }
      if (!voices.length) throw new Error("no voices returned");
      voiceCache = voices;
    }
    res.json(voiceCache);
  } catch (err) {
    res.status(500).json({ error: `Could not load voices: ${String(err.message || err)}` });
  }
});

app.post("/api/tts", async (req, res) => {
  const { text, voice = "en-US-GuyNeural" } = req.body || {};

  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Please enter some text." });
  }
  if (text.length > 3000) {
    return res.status(400).json({ error: "Text is too long (max 3000 characters)." });
  }
  if (!/^[A-Za-z][A-Za-z-]{1,40}$/.test(voice)) {
    return res.status(400).json({ error: "Invalid voice." });
  }

  // Light rate limit in public mode (30 generations / hour per IP)
  if (MODE === "public") {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    const now = Date.now();
    const hits = (rateHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
    if (hits.length >= 30) {
      return res.status(429).json({ error: "Too many requests from your network — try again later." });
    }
    hits.push(now);
    rateHits.set(ip, hits);
  }

  const tmpFile = path.join(
    MODE === "local" ? LOCAL_DIR : TEMP_DIR,
    `tts-${crypto.randomBytes(6).toString("hex")}.mp3`
  );

  try {
    await new Promise((resolve, reject) => {
      const proc = spawn("python", [
        "-m", "edge_tts",
        "--voice", voice,
        "--text", text,
        "--write-media", tmpFile,
      ], { windowsHide: true });

      let stderr = "";
      proc.stderr.on("data", (c) => { stderr += c.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0 && fs.existsSync(tmpFile)) resolve();
        else reject(new Error(stderr.trim() || `edge-tts exited with code ${code}`));
      });
    });

    // Stream to the user's device, then delete the server copy (public mode)
    res.download(tmpFile, `speech-${voice}.mp3`, (err) => {
      if (err && !res.headersSent) res.status(500).end();
      if (MODE === "public") { try { fs.unlinkSync(tmpFile); } catch {} }
    });
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    res.status(500).json({ error: `Speech generation failed: ${String(err.message || err).slice(0, 200)}` });
  }
});

/* ------------------------------------------------------------------ */
/* PO token provider (bgutil) — only in the container. Generates YouTube
 * proof-of-origin tokens so downloads from datacenter IPs are far less
 * likely to hit "Sign in to confirm you're not a bot". The yt-dlp plugin
 * is installed via pip and talks to this server on 127.0.0.1:4416.      */

const BGUTIL_SERVER = "/opt/bgutil/server/build/main.js";
let potProviderOk = false;

/** Is the bgutil PO-token provider responding on 127.0.0.1:4416? */
function checkPotProvider(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get("http://127.0.0.1:4416/ping", { timeout: timeoutMs }, (res) => {
      res.resume();
      potProviderOk = res.statusCode === 200;
      resolve(potProviderOk);
    });
    req.on("timeout", () => { req.destroy(); potProviderOk = false; resolve(false); });
    req.on("error", () => { potProviderOk = false; resolve(false); });
  });
}

if (MODE === "public" && fs.existsSync(BGUTIL_SERVER)) {
  try {
    spawn("node", [BGUTIL_SERVER, "--host", "127.0.0.1", "--port", "4416"], {
      stdio: "ignore",
    }).unref();
    console.log("[pot] bgutil PO token provider starting on 127.0.0.1:4416");
    setTimeout(async () => {
      const ok = await checkPotProvider(3000);
      console.log(`[pot] provider ${ok ? "responding" : "NOT responding — yt-dlp will lack PO tokens"}`);
    }, 3000);
  } catch (err) {
    console.error("[pot] could not start bgutil provider:", String(err.message || err));
  }
}

/* ------------------------------------------------------------------ */
/* API: video generator — script → narrated vertical video             */
/* (edge-tts word timings + ffmpeg animated background + karaoke caps) */
/* ------------------------------------------------------------------ */

const VIDEO_STYLES = {
  auto:   { c0: "0x38bdf8", c1: "0x6366f1", name: "Auto (adaptive colors)", auto: true },
  ocean:  { c0: "0x0b1f3a", c1: "0x0e7a5f", name: "Ocean (navy → green)" },
  sunset: { c0: "0x2b0a4d", c1: "0xc2410c", name: "Sunset (purple → orange)" },
  night:  { c0: "0x111827", c1: "0x4b5563", name: "Night (charcoal)" },
  blank:  { c0: "0xffffff", c1: "0xffffff", name: "Blank (plain white screen)" },
};

/* Narration delivery presets (edge-tts rate/pitch tweaks). */
const AUDIO_STYLES = {
  story:    { rate: "-8%",  pitch: "-4Hz", name: "Storyteller" },
  podcast:  { rate: "-3%",  pitch: "+2Hz", name: "Podcast" },
  dialogue: { rate: "+3%",  pitch: "+5Hz", name: "Dialogue" },
  narrator: { rate: "-12%", pitch: "-8Hz", name: "Movie Narrator" },
  news:     { rate: "+6%",  pitch: "+0Hz", name: "Newsreader" },
  hype:     { rate: "+12%", pitch: "+6Hz", name: "Hype / Excited" },
};

/* audioStyle "auto": per-scene delivery picked from the scene's mood. */
const AUDIO_MOODS = {
  hype:     ["celebrate", "victory", "triumph", "amazing", "wow", "cheer", "fanfare", "approved", "hooray", "finally", "wildly", "jump"],
  narrator: ["mystery", "mysterious", "dark", "night", "horror", "secret", "shadow", "silence", "whisper", "space", "alien", "glowing", "ship", "spaceship"],
  news:     ["business", "tax", "audit", "paperwork", "report", "office", "deduction", "official", "stamp", "money", "cost"],
  podcast:  ["think", "thought", "remember", "wonder", "honestly", "maybe", "question", "idea", "consider"],
  dialogue: ["hello", "hey", "said", "says", "talk", "asked", "demand", "shout", "argue", "popped"],
};
const AUDIO_MOOD_RE = Object.entries(AUDIO_MOODS).map(([id, keys]) => [
  id,
  keys.map((k) => new RegExp(`\\b${k}`, "i")),
]);
function pickAudioStyleId(text) {
  const t = String(text);
  for (const [id, res] of AUDIO_MOOD_RE) {
    if (res.some((re) => re.test(t))) return id;
  }
  return "story";
}

/* Speed a delivery preset up (keeps storyboard timestamps accurate when a
 * voiceover is longer than its scene slot). */
function fasterTune(tune, speedup) {
  const base = tune && tune.rate ? parseInt(tune.rate, 10) : 0;
  const pct = Math.min(40, (Number.isNaN(base) ? 0 : base) + speedup);
  return { rate: `${pct >= 0 ? "+" : ""}${pct}%`, pitch: tune ? tune.pitch : "+0Hz" };
}

/* Stick-figure renderer (character animation + story mode). Loaded lazily —
 * if the canvas package is unavailable the gradient style still works. */
let STICKMAN = null;
try {
  STICKMAN = require("./scripts/stickman");
} catch (err) {
  console.error("[video] stickman renderer unavailable — character animation disabled:", String(err.message || err));
}

function videoBusyCount() {
  return [...jobs.values()].filter(
    (j) => j.kind === "video" && (j.status === "starting" || j.status === "downloading")
  ).length;
}

function assTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Word timings → ASS with karaoke (\k) word-by-word yellow highlight. */
function buildAss(words) {
  const groups = [];
  let group = [];
  const flush = () => {
    if (group.length) { groups.push(group); group = []; }
  };
  for (const w of words) {
    if (group.length) {
      const gap = w.start - group[group.length - 1].end;
      if (group.length >= 5 || gap > 0.7 || w.w.length > 14) flush();
    }
    group.push(w);
  }
  flush();

  let events = "";
  for (const g of groups) {
    const start = g[0].start;
    const end = Math.max(g[g.length - 1].end + 0.3, start + 0.8);
    let t = start;
    let txt = "";
    g.forEach((w, i) => {
      const gapCs = i === 0 ? 0 : Math.max(0, Math.round((w.start - t) * 100));
      const durCs = Math.max(1, Math.round((w.end - w.start) * 100));
      txt += `${i > 0 ? " " : ""}${gapCs > 0 ? `{\\k${gapCs}}` : ""}{\\k${durCs}}${w.w}`;
      t = w.end;
    });
    events += `Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,${txt}\n`;
  }

  return `[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,62,&H0000D7FF,&H00FFFFFF,&H00101010,&H80000000,1,0,0,0,100,100,0,0,1,4,2,2,40,40,210,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`;
}

function startVideoJob(text, voice, style, audioStyle = "") {
  const job = createJob("");
  const audioTune = audioStyle === "auto"
    ? AUDIO_STYLES[pickAudioStyleId(text)] ?? AUDIO_STYLES.story
    : AUDIO_STYLES[audioStyle];
  job.kind = "video";
  job.status = "downloading";
  job.title = "Generated video";
  job.note = "Generating the voice…";

  const dir = MODE === "local" ? LOCAL_DIR : TEMP_DIR;
  const base = path.join(dir, `vid-${job.id}`);
  const audio = `${base}.mp3`;
  const wordsFile = `${base}.json`;
  const ass = `${base}.ass`;
  const out = path.join(dir, MODE === "local" ? `video-${job.id}.mp4` : `${job.id}-generated-video.mp4`);
  job.filename = path.basename(out);

  let ff = null;
  let killed = false;

  const cleanup = () => { for (const f of [audio, wordsFile, ass]) { try { fs.unlinkSync(f); } catch {} } };
  const fail = (msg) => { job.status = "error"; job.error = msg; cleanup(); };

  (async () => {
    try {
      // 1. Narration + per-word timing (edge-tts streaming API, WordBoundary)
      await new Promise((resolve, reject) => {
        const p = spawn("python", [
          path.join(__dirname, "scripts", "video_voice.py"),
          text, voice, audio, wordsFile,
          audioTune ? audioTune.rate : "+0%", audioTune ? audioTune.pitch : "+0Hz",
        ], { windowsHide: true });
        let err = "";
        p.stderr.on("data", (c) => { err += c.toString(); });
        p.on("error", reject);
        p.on("close", (code) =>
          code === 0 && fs.existsSync(audio)
            ? resolve()
            : reject(new Error(err.trim().split("\n").slice(-2).join(" ") || "voice generation failed")));
      });

      // 2. Karaoke captions
      const words = JSON.parse(fs.readFileSync(wordsFile, "utf8"));
      if (!words.length) throw new Error("voice returned no word timings");
      fs.writeFileSync(ass, buildAss(words), "utf8");
      const dur = Math.max(words[words.length - 1].end + 1.2, 2);

      // 3. Render: animated gradient background + captions over the voice
      job.note = "Rendering the video…";
      const s = VIDEO_STYLES[style];
      // cwd = output dir so the ass filter arg needs no absolute path
      // (colons in Windows drive letters break ffmpeg filter parsing)
      // 540x960 (libass scales the 720x1280 PlayRes) + tiny x264 buffers keep
      // memory far under the Render free instance's 512MB limit.
      const args = [
        "-y",
        "-i", audio,
        "-f", "lavfi", "-i",
        `gradients=s=540x960:speed=0.02:c0=${s.c0}:c1=${s.c1}`,
        "-vf", `fps=10,ass=${path.basename(ass)},format=yuv420p`,
        "-map", "1:v", "-map", "0:a",
        "-shortest", "-t", "60",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "2",
        "-x264-params", "rc-lookahead=0:bframes=0",
        "-filter_threads", "1",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        out,
        "-progress", "pipe:1", "-nostats",
      ];
      ff = spawn("ffmpeg", args, { windowsHide: true, cwd: dir });
      job.proc = ff;

      let buf = "";
      ff.stdout.on("data", (c) => {
        buf += c.toString();
        let last = 0;
        const m = /out_time_ms=(\d+)/g;
        let match;
        while ((match = m.exec(buf))) last = Number(match[1]);
        if (last) job.percent = Math.min(99, (last / 1e6 / dur) * 100);
      });
      let stderrTail = "";
      ff.stderr.on("data", (c) => { stderrTail = (stderrTail + c.toString()).split("\n").slice(-4).join("\n"); });

      const timer = setTimeout(() => {
        killed = true;
        try { ff.kill("SIGKILL"); } catch {}
        fail("The video took too long to render. Try a shorter script.");
      }, 10 * 60 * 1000);

      ff.on("close", (code) => {
        clearTimeout(timer);
        if (killed) return;
        if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 10_000) {
          job.status = "done";
          job.percent = 100;
          job.filepath = out;
          job.size = fs.statSync(out).size;
          cleanup();
        } else {
          fail(`Video rendering failed. Try again (maybe with a shorter script).${stderrTail ? ` [${stderrTail.slice(0, 500)}]` : ""}`);
        }
      });
    } catch (err) {
      fail(String(err.message || err).slice(0, 250));
    }
  })();

  return job;
}

/**
 * Stick-figure video job: the character acts out the script while karaoke
 * captions play. Two modes:
 *   storyScenes = null    → whole text narrated, scenes built from the words
 *   storyScenes = [...]   → timestamped storyboard (Gemini/ChatGPT style):
 *                           each scene's Voiceover is narrated onto its
 *                           timeline slot; the Visual description picks the
 *                           action; the scene title shows as a card.
 */
function startFigureJob(text, voice, style, characterId, storyScenes, audioStyle = "") {
  const job = createJob("");
  const audioTune = audioStyle === "auto" ? null : AUDIO_STYLES[audioStyle];
  job.kind = "video";
  job.status = "downloading";
  job.title = "Generated video";
  job.note = storyScenes ? "Reading the storyboard…" : "Generating the voice…";

  const dir = MODE === "local" ? LOCAL_DIR : TEMP_DIR;
  const base = path.join(dir, `vid-${job.id}`);
  const audio = `${base}.mp3`;
  const wordsFile = `${base}.json`;
  const framesDir = path.join(dir, `frames-${job.id}`);
  const partsDir = path.join(dir, `parts-${job.id}`);
  const out = path.join(dir, MODE === "local" ? `video-${job.id}.mp4` : `${job.id}-generated-video.mp4`);
  job.filename = path.basename(out);

  let ff = null;
  let killed = false;

  const cleanup = () => {
    for (const f of [audio, wordsFile]) { try { fs.unlinkSync(f); } catch {} }
    for (const d of [framesDir, partsDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  };
  const fail = (msg) => {
    job.status = "error";
    job.error = msg;
    cleanup();
    if (ff) { try { ff.kill("SIGKILL"); } catch {} }
  };
  const runFfmpeg = (args) =>
    new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", args, { windowsHide: true });
      let err = "";
      p.stderr.on("data", (c) => { err += c.toString(); });
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().split("\n").slice(-2).join(" ") || "ffmpeg failed"))));
    });
  const runVoice = (t, mp3, json, tune = audioTune) =>
    new Promise((resolve, reject) => {
      const p = spawn("python", [
        path.join(__dirname, "scripts", "video_voice.py"), t, voice, mp3, json,
        tune ? tune.rate : "+0%", tune ? tune.pitch : "+0Hz",
      ], { windowsHide: true });
      let err = "";
      p.stderr.on("data", (c) => { err += c.toString(); });
      p.on("error", reject);
      p.on("close", (code) =>
        code === 0 && fs.existsSync(mp3)
          ? resolve()
          : reject(new Error(err.trim().split("\n").slice(-2).join(" ") || "voice generation failed")));
    });

  (async () => {
    try {
      const words = [];
      let timeline = null;

      if (storyScenes) {
        // Story mode: one narration per scene, placed on its timeline slot.
        fs.mkdirSync(partsDir, { recursive: true });
        timeline = [];
        const listLines = [];
        let cursor = 0;
        for (let i = 0; i < storyScenes.length && cursor < 59; i++) {
          const sc = storyScenes[i];
          const start = cursor;
          const slotMp3 = path.join(partsDir, `slot-${i}.mp3`);

          let narrWords = [];
          const narrMp3 = path.join(partsDir, `narr-${i}.mp3`);
          // Scenes without a Voiceover line (AI "master prompt" style scripts)
          // narrate their title — trimmed so it fits the timeline slot
          // (~15 spoken characters per second).
          let narrText = sc.voiceover;
          const slotGuess = Math.max(2, sc.t1 - sc.t0);
          if (!narrText && sc.title) {
            narrText = sc.title.slice(0, Math.max(24, Math.round(slotGuess * 15)));
          }
          // audioStyle "auto": each scene gets a delivery matching its mood.
          let tune = audioStyle === "auto"
            ? AUDIO_STYLES[pickAudioStyleId(`${sc.title || ""} ${sc.visual || ""} ${sc.voiceover || ""}`)]
            : audioTune;
          if (narrText) {
            const narrWordsFile = path.join(partsDir, `narr-${i}.json`);
            await runVoice(narrText, narrMp3, narrWordsFile, tune);
            narrWords = JSON.parse(fs.readFileSync(narrWordsFile, "utf8"));
            // Timestamp accuracy: if the narration overruns its storyboard
            // slot, re-render it faster (once) so scenes stay on their times.
            const over = (narrWords.length ? narrWords[narrWords.length - 1].end + 0.3 : 0) - slotGuess * 0.95;
            if (over > 0) {
              const speedup = Math.min(35, Math.round((over / (slotGuess * 0.88)) * 100) + 5);
              tune = fasterTune(tune, speedup);
              await runVoice(narrText, narrMp3, narrWordsFile, tune);
              narrWords = JSON.parse(fs.readFileSync(narrWordsFile, "utf8"));
            }
          }
          const narrLen = narrWords.length ? narrWords[narrWords.length - 1].end + 0.3 : 0;
          // narration lands at the storyboard time, but never before this slot
          const delay = Math.max(0, Math.min(sc.t0 - start, Math.max(0, sc.t1 - sc.t0 - narrLen)));
          const end = Math.min(Math.max(sc.t1, start + delay + narrLen, start + 2), 60);
          const slotLen = end - start;

          if (narrWords.length) {
            for (const w of narrWords) words.push({ w: w.w, start: start + delay + w.start, end: start + delay + w.end });
            await runFfmpeg([
              "-y", "-i", narrMp3,
              "-af", `adelay=delays=${Math.round(delay * 1000)}:all=1,apad=whole_dur=${slotLen.toFixed(3)}`,
              "-c:a", "libmp3lame", "-q:a", "4", slotMp3,
            ]);
          } else {
            await runFfmpeg([
              "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
              "-t", slotLen.toFixed(3),
              "-c:a", "libmp3lame", "-q:a", "4", slotMp3,
            ]);
          }
          listLines.push(`file '${slotMp3.replace(/\\/g, "/")}'`);
          timeline.push({
            start,
            end,
            action: STICKMAN.matchAction(sc.visual) ?? STICKMAN.matchAction(sc.voiceover) ?? STICKMAN.pickAction("", i),
            title: (sc.title || "").slice(0, 60),
            colors: sc.colors || "",
          });
          cursor = end;
          job.percent = 2 + Math.round((i / Math.max(1, storyScenes.length)) * 12);
        }
        if (!timeline.length) throw new Error("storyboard produced no scenes");
        const listFile = path.join(partsDir, "list.txt");
        fs.writeFileSync(listFile, listLines.join("\n"), "utf8");
        await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c:a", "libmp3lame", "-q:a", "4", audio]);
      } else {
        // Plain mode: narrate the whole text once.
        await runVoice(text, audio, wordsFile);
        words.push(...JSON.parse(fs.readFileSync(wordsFile, "utf8")));
      }
      if (!words.length) throw new Error("voice returned no word timings");

      // 2. Stick-figure animation frames
      job.note = "Animating the scene…";
      const render = await STICKMAN.renderStickmanFrames({
        words,
        scenes: timeline || undefined,
        framesDir,
        style: VIDEO_STYLES[style],
        characterId,
        onProgress: (p) => { job.percent = Math.min(69, p); },
      });

      // 3. Encode frames + narration
      job.note = "Rendering the video…";
      const args = [
        "-y",
        "-framerate", String(render.fps),
        "-i", `${path.basename(framesDir)}/f%04d.png`,
        "-i", path.basename(audio),
        "-map", "0:v", "-map", "1:a",
        "-shortest",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23", "-threads", "2",
        "-x264-params", "rc-lookahead=0:bframes=0",
        "-filter_threads", "1",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart",
        path.basename(out),
        "-progress", "pipe:1", "-nostats",
      ];
      ff = spawn("ffmpeg", args, { windowsHide: true, cwd: dir });
      job.proc = ff;

      let buf = "";
      ff.stdout.on("data", (c) => {
        buf += c.toString();
        let last = 0;
        const m = /out_time_ms=(\d+)/g;
        let match;
        while ((match = m.exec(buf))) last = Number(match[1]);
        if (last && render.duration) job.percent = Math.min(99, 70 + (last / 1e6 / render.duration) * 29);
      });
      let stderrTail = "";
      ff.stderr.on("data", (c) => { stderrTail = (stderrTail + c.toString()).split("\n").slice(-4).join("\n"); });

      const timer = setTimeout(() => {
        killed = true;
        try { ff.kill("SIGKILL"); } catch {}
        fail("The video took too long to render. Try a shorter script.");
      }, 15 * 60 * 1000);

      ff.on("close", (code) => {
        clearTimeout(timer);
        if (killed) return;
        if (code === 0 && fs.existsSync(out) && fs.statSync(out).size > 10_000) {
          job.status = "done";
          job.percent = 100;
          job.filepath = out;
          job.size = fs.statSync(out).size;
          cleanup();
        } else {
          fail(`Video rendering failed. Try again (maybe with a shorter script).${stderrTail ? ` [${stderrTail.slice(0, 500)}]` : ""}`);
        }
      });
    } catch (err) {
      fail(String(err.message || err).slice(0, 500));
    }
  })();

  return job;
}

app.post("/api/video", (req, res) => {  const { text, voice = "en-US-GuyNeural", style = "ocean", character = "", audioStyle = "" } = req.body || {};
  if (!text || typeof text !== "string" || text.trim().length < 10) {
    return res.status(400).json({ error: "Please enter a script (at least 10 characters)." });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: "Script is too long (5000 characters max — about 60 seconds of video)." });
  }
  if (!/^[A-Za-z][A-Za-z-]{1,40}$/.test(voice)) return res.status(400).json({ error: "Invalid voice." });
  if (!VIDEO_STYLES[style]) return res.status(400).json({ error: "Invalid style." });
  if (audioStyle && audioStyle !== "auto" && !AUDIO_STYLES[audioStyle]) return res.status(400).json({ error: "Unknown audio style." });
  let characterId = "";
  if (character) {
    if (!STICKMAN || !STICKMAN.CHARACTERS.some((c) => c.id === character)) {
      return res.status(400).json({ error: "Unknown character." });
    }
    characterId = character;
  }
  if (videoBusyCount() >= 2) {
    return res.status(429).json({ error: "The video studio is busy — please try again in a moment." });
  }
  const trimmed = text.trim();
  // Timestamped storyboard (Gemini/ChatGPT style) → story mode when a
  // character was picked; plain narration otherwise. Prompt-style scripts
  // (scenes without Voiceover lines AND without titles) have nothing to
  // narrate per scene, so they fall back to plain narration.
  let storyScenes = STICKMAN ? STICKMAN.parseStoryScript(trimmed) : [];
  if (storyScenes.length && !storyScenes.some((s) => s.voiceover || s.title)) storyScenes = [];
  if (storyScenes.length && characterId) {
    return res.json({ jobId: startFigureJob(trimmed, voice, style, characterId, storyScenes, audioStyle).id });
  }
  if (characterId) {
    return res.json({ jobId: startFigureJob(trimmed, voice, style, characterId, null, audioStyle).id });
  }
  res.json({ jobId: startVideoJob(trimmed, voice, style, audioStyle).id });
});

app.listen(PORT, () => {
  console.log(`\n  own downloader [${MODE}]  ->  http://localhost:${PORT}`);
  if (MODE === "local") console.log(`  Files are saved to:     ${LOCAL_DIR}\n`);
});
