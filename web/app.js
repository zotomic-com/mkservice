/* own downloader — main downloader logic (works in local & public mode) */

const $ = (id) => document.getElementById(id);

const state = {
  mode: "local",        // "local" | "public" (from /api/config)
  info: null,
  selectedQuality: "best",
  jobId: null,
  pollTimer: null,
};

const API = (p) => CONFIG.API_URL + p;

/* ------------------------------------------------------------------ */

const PLATFORM_COLORS = {
  YouTube: "#ff5a5f",
  TikTok: "#4ef2e8",
  Instagram: "#ff77c8",
  Facebook: "#6ba3ff",
};

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function setError(msg) {
  const el = $("input-error");
  if (msg) { el.textContent = msg; show(el); } else { hide(el); }
}

function formatBytes(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ------------------------------------------------------------------ */
/* Sidebar navigation                                                  */
/* ------------------------------------------------------------------ */

document.querySelectorAll(".nav-item[data-pane]").forEach((btn) => {
  btn.addEventListener("click", () => switchPane(btn.dataset.pane));
});

function switchPane(which) {
  document.querySelectorAll(".nav-item[data-pane]").forEach((b) =>
    b.classList.toggle("active", b.dataset.pane === which));
  ["dl", "tts", "profile"].forEach((p) => {
    const pane = $("pane-" + p);
    if (pane) pane.classList.toggle("hidden", p !== which);
  });
  if (which === "profile") renderProfile();
}

/* ------------------------------------------------------------------ */
/* Init: detect server mode, restore session, load history             */
/* ------------------------------------------------------------------ */

(async function init() {
  try {
    const res = await fetch(API("/api/config"));
    state.mode = (await res.json()).mode || "local";
  } catch {
    setError("Cannot reach the downloader server. Is it running?");
  }

  await Auth.init();
  History.reload();
  // Deep-link panes (e.g. index.html#tts opens the Audio tool)
  if (location.hash === "#tts") switchPane("tts");
})();

/* ------------------------------------------------------------------ */
/* Fetch info                                                          */
/* ------------------------------------------------------------------ */

$("url-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const url = $("url").value.trim();
  setError("");
  if (!url) return;

  const btn = $("fetch-btn");
  btn.disabled = true;
  hide($("info-card"));
  hide($("progress-card"));
  show($("loader"));

  try {
    const res = await fetch(API("/api/info"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong.");

    state.info = data;
    state.selectedQuality = "best";
    renderInfo(data);
  } catch (err) {
    setError(err.message);
  } finally {
    btn.disabled = false;
    hide($("loader"));
  }
});

function renderInfo(info) {
  $("thumb").src = info.thumbnail || "";
  const tag = $("platform-tag");
  tag.textContent = info.platform;
  tag.style.color = PLATFORM_COLORS[info.platform] || "#fff";

  $("title").textContent = info.title;
  const bits = [];
  if (info.uploader) bits.push(info.uploader);
  if (info.duration) bits.push(info.duration);
  if (info.viewCount) bits.push(`${info.viewCount.toLocaleString()} views`);
  $("meta").textContent = bits.join("  ·  ");

  const grid = $("quality-grid");
  grid.innerHTML = "";
  const qualities = info.isLive ? [] : info.qualities || [];
  for (const q of qualities) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "q-btn" + (q.id === state.selectedQuality ? " active" : "");
    b.textContent = q.label;
    b.addEventListener("click", () => {
      state.selectedQuality = q.id;
      grid.querySelectorAll(".q-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
    });
    grid.appendChild(b);
  }
  if (info.isLive) {
    const note = document.createElement("span");
    note.className = "q-btn";
    note.style.cursor = "default";
    note.textContent = "🔴 Live stream";
    grid.appendChild(note);
  }

  show($("info-card"));
}

/* ------------------------------------------------------------------ */
/* Download                                                            */
/* ------------------------------------------------------------------ */

$("dl-video").addEventListener("click", () => startDownload("video"));
$("dl-audio").addEventListener("click", () => startDownload("audio"));
$("reset").addEventListener("click", () => {
  $("url").value = "";
  hide($("info-card"));
  hide($("progress-card"));
  setError("");
  state.info = null;
});

async function startDownload(mode) {
  if (!state.info) return;
  setError("");

  const res = await fetch(API("/api/download"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: $("url").value.trim(),
      mode,
      qualityId: state.selectedQuality,
    }),
  });

  const data = await res.json();
  if (!res.ok) { setError(data.error || "Could not start download."); return; }

  state.jobId = data.jobId;
  const card = $("progress-card");
  card.classList.remove("done", "error");
  $("prog-label").textContent = mode === "audio" ? "Extracting audio…" : "Downloading…";
  hide($("prog-done"));
  hide($("prog-error"));
  hide($("save-row"));
  setProgress(0, "", "");
  show(card);

  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(pollProgress, 900);
  pollProgress();
}

async function pollProgress() {
  if (!state.jobId) return;
  try {
    const res = await fetch(API(`/api/progress/${state.jobId}`));
    if (!res.ok) { clearInterval(state.pollTimer); return; }
    const j = await res.json();

    if (j.status === "downloading") {
      $("prog-label").textContent = "Downloading…";
      setProgress(j.percent, j.speed, j.eta);
    } else if (j.status === "done") {
      clearInterval(state.pollTimer);
      setProgress(100, "", "");
      $("progress-card").classList.add("done");
      $("prog-label").textContent = "Finished ✓";
      showDone(j);
      state.jobId = null;
    } else if (j.status === "error") {
      clearInterval(state.pollTimer);
      $("progress-card").classList.add("error");
      $("prog-label").textContent = "Failed ✗";
      const el = $("prog-error");
      el.textContent = j.error || "Unknown error.";
      show(el);
      state.jobId = null;
    }
  } catch { /* keep polling */ }
}

function showDone(j) {
  const qualityLabel =
    (state.info?.qualities || []).find((q) => q.id === state.selectedQuality)?.label || "";

  // Record history (metadata/links only — never files)
  History.add({
    url: $("url").value.trim(),
    title: state.info?.title || "",
    platform: state.info?.platform || "",
    quality: qualityLabel,
    mode: $("dl-audio") && j.filename && j.filename.endsWith(".mp3") ? "audio" : "video",
  });

  const saveRow = $("save-row");
  saveRow.innerHTML = "";
  if (state.mode === "local") {
    $("prog-done").innerHTML =
      `Saved as <code>downloads/${escapeHtml(j.filename)}</code> — ` +
      `<a href="${API(`/api/file-by-name/${encodeURIComponent(j.filename)}`)}">save a copy in your browser</a> · ` +
      `<a href="#" id="open-folder-link">open folder ↗</a>`;
    show($("prog-done"));
    const link = document.getElementById("open-folder-link");
    if (link) link.addEventListener("click", (e) => { e.preventDefault(); openFolder(j.filename); });
  } else {
    // Public mode: stream the file straight to the user's device
    $("prog-done").textContent = "Your file is ready — it will be saved to your device now:";
    show($("prog-done"));
    const a = document.createElement("a");
    a.className = "btn primary";
    a.href = API(`/api/file/${j.id}`);
    a.textContent = `⬇  Save to my device (${formatBytes(j.size)})`;
    saveRow.appendChild(a);
    show(saveRow);
  }
}

async function openFolder(name) {
  try {
    await fetch(API("/api/open-folder"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name || null }),
    });
  } catch { /* ignore */ }
}

function setProgress(percent, speed, eta) {
  $("prog-fill").style.width = `${Math.min(100, percent)}%`;
  $("prog-percent").textContent = `${Math.round(percent)}%`;
  $("prog-speed").textContent = speed || "";
  $("prog-eta").textContent = eta ? `ETA ${eta}` : "";
}
