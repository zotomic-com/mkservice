/* own downloader — Text → Audio tab (edge-tts, free neural voices) */

const $t = (id) => document.getElementById(id);

let allVoices = [];
let selectedVoice = "en-US-GuyNeural";

/* ---------- tab switching ---------- */

$t("tab-dl").addEventListener("click", () => switchPane("dl"));
$t("tab-tts").addEventListener("click", () => switchPane("tts"));

function switchPane(which) {
  $t("tab-dl").classList.toggle("active", which === "dl");
  $t("tab-tts").classList.toggle("active", which === "tts");
  $t("pane-dl").classList.toggle("hidden", which !== "dl");
  $t("pane-tts").classList.toggle("hidden", which !== "tts");
}

/* ---------- voice list ---------- */

(async function loadVoices() {
  const sel = $t("tts-voice");
  try {
    const res = await fetch(API("/api/tts/voices"));
    allVoices = await res.json();
    if (!Array.isArray(allVoices)) throw new Error("bad response");
  } catch {
    sel.innerHTML = '<option value="en-US-GuyNeural">en-US-GuyNeural (default)</option>';
    return;
  }
  renderVoices("");
})();

function renderVoices(query) {
  const sel = $t("tts-voice");
  const q = (query || "").toLowerCase();
  const filtered = allVoices.filter((v) =>
    !q || v.id.toLowerCase().includes(q) || v.locale.toLowerCase().includes(q)
  ).slice(0, 400);

  sel.innerHTML = "";
  for (const v of filtered) {
    const opt = document.createElement("option");
    const lang = v.locale || "";
    opt.value = v.id;
    opt.textContent = `${lang}  ·  ${v.id.replace(/--.*$/, "")}  (${v.gender})`;
    if (v.id === selectedVoice) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!filtered.length) sel.innerHTML = '<option disabled>No voices match your search</option>';
  // default: pick first US English voice if nothing selected
  if (!filtered.some((v) => v.id === selectedVoice) && filtered.length) {
    selectedVoice = filtered[0].id;
    sel.selectedIndex = 0;
  }
}

$t("tts-search").addEventListener("input", (e) => renderVoices(e.target.value));

$t("tts-voice").addEventListener("change", (e) => { selectedVoice = e.target.value; });

/* ---------- character counter ---------- */

$t("tts-text").addEventListener("input", (e) => {
  $t("tts-char-count").textContent = `${e.target.value.length} / 3000`;
});

/* ---------- generate ---------- */

$t("tts-btn").addEventListener("click", async () => {
  const text = $t("tts-text").value.trim();
  const errEl = $t("tts-error");
  errEl.classList.add("hidden");

  if (!text) { errEl.textContent = "Please enter some text first."; errEl.classList.remove("hidden"); return; }

  const btn = $t("tts-btn");
  btn.disabled = true;
  btn.textContent = "⏳ Generating…";
  $t("tts-status").classList.remove("hidden");
  $t("tts-result").classList.add("hidden");

  try {
    const res = await fetch(API("/api/tts"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: selectedVoice }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server error (${res.status})`);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);

    const audio = $t("tts-audio");
    audio.src = url;

    const dl = $t("tts-download");
    dl.href = url;
    dl.download = `speech-${selectedVoice}.mp3`;

    $t("tts-result").classList.remove("hidden");
    audio.play().catch(() => {}); // autoplay best-effort
  } catch (err) {
    errEl.textContent = err.message || "Generation failed.";
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = "🔊 Generate audio";
    $t("tts-status").classList.add("hidden");
  }
});
