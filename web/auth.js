/* own downloader — auth & account management (Supabase, optional) */

const authEnabled = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
const sb = authEnabled
  ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY)
  : null;

const Auth = {
  user: null,
  isAdmin: false,

  async init() {
    if (!authEnabled) { renderAuthArea(); return; }
    const { data } = await sb.auth.getSession();
    this.user = data?.session?.user || null;
    await this.refreshRole();
    sb.auth.onAuthStateChange(async () => {
      const { data: d } = await sb.auth.getSession();
      this.user = d?.session?.user || null;
      await this.refreshRole();
      renderAuthArea();
      History.reload();
    });
    renderAuthArea();
  },

  async refreshRole() {
    this.isAdmin = false;
    if (!this.user) return;
    const { data } = await sb.from("profiles").select("role").eq("id", this.user.id).maybeSingle();
    this.isAdmin = data?.role === "admin";
  },

  async signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
    await this.refreshRole();
    return this.user;
  },

  async signUp(email, password) {
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    await sb.auth.signOut();
    this.user = null;
    this.isAdmin = false;
  },
};

/* ------------------------------------------------------------------ */
/* Header UI                                                           */
/* ------------------------------------------------------------------ */

function renderAuthArea() {
  const area = document.getElementById("auth-area");
  if (!authEnabled) { area.innerHTML = ""; return; }

  if (!Auth.user) {
    area.innerHTML = `<button id="open-auth" class="btn ghost small-btn">Sign in</button>`;
    document.getElementById("open-auth").addEventListener("click", openAuthModal);
    return;
  }

  const email = Auth.user.email || "account";
  area.innerHTML = `
    <span class="account-chip">
      <span class="dot"></span>${escapeHtml(email)}
    </span>
    ${Auth.isAdmin ? `<a href="admin.html" class="btn ghost small-btn">Admin</a>` : ""}
    <button id="signout-btn" class="btn text small-btn">Sign out</button>
  `;
  document.getElementById("signout-btn").addEventListener("click", Auth.signOut.bind(Auth));
}

/* ------------------------------------------------------------------ */
/* Modal                                                               */
/* ------------------------------------------------------------------ */

function openAuthModal() {
  document.getElementById("auth-modal").classList.remove("hidden");
  setAuthError("");
}

function closeAuthModal() {
  document.getElementById("auth-modal").classList.add("hidden");
}

function setAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (msg) { el.textContent = msg; el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

document.getElementById("auth-close").addEventListener("click", closeAuthModal);
document.getElementById("auth-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeAuthModal();
});

document.getElementById("tab-signin").addEventListener("click", () => switchTab(true));
document.getElementById("tab-signup").addEventListener("click", () => switchTab(false));

function switchTab(signin) {
  document.getElementById("tab-signin").classList.toggle("active", signin);
  document.getElementById("tab-signup").classList.toggle("active", !signin);
  document.getElementById("auth-submit").textContent = signin ? "Sign in" : "Create account";
  setAuthError("");
}

document.getElementById("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!authEnabled) return;
  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value;
  const isSignin = document.getElementById("tab-signin").classList.contains("active");
  const btn = document.getElementById("auth-submit");
  btn.disabled = true;
  setAuthError("");
  try {
    if (isSignin) {
      await Auth.signIn(email, password);
    } else {
      const data = await Auth.signUp(email, password);
      if (!data.session) {
        setAuthError("Account created! Check your email to confirm, then sign in.");
        return;
      }
      Auth.user = data.user;
      await Auth.refreshRole();
    }
    closeAuthModal();
    renderAuthArea();
    History.reload();
  } catch (err) {
    setAuthError(err.message || "Something went wrong.");
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* Download history — guests: browser only (24h); users: Supabase      */
/* ------------------------------------------------------------------ */

const History = {
  GUEST_KEY: "od_guest_history",
  TTL: 24 * 60 * 60 * 1000, // 24 hours

  add(entry) {
    if (authEnabled && Auth.user) {
      sb.from("downloads").insert({
        user_id: Auth.user.id,
        url: entry.url,
        title: entry.title,
        platform: entry.platform,
        quality: entry.quality,
        mode: entry.mode,
      }).then(() => this.reload());
    } else {
      const list = JSON.parse(localStorage.getItem(this.GUEST_KEY) || "[]");
      list.unshift({ ...entry, ts: Date.now() });
      localStorage.setItem(this.GUEST_KEY, JSON.stringify(list.slice(0, 50)));
      this.reload();
    }
  },

  async load() {
    if (authEnabled && Auth.user) {
      const { data } = await sb.from("downloads")
        .select("*").eq("user_id", Auth.user.id)
        .order("created_at", { ascending: false }).limit(50);
      return (data || []).map((r) => ({ ...r, ts: new Date(r.created_at).getTime() }));
    }
    // Guests: keep only entries from the last 24h (auto-delete)
    const now = Date.now();
    const list = JSON.parse(localStorage.getItem(this.GUEST_KEY) || "[]")
      .filter((r) => now - r.ts < this.TTL);
    localStorage.setItem(this.GUEST_KEY, JSON.stringify(list));
    return list;
  },

  async clear() {
    if (authEnabled && Auth.user) {
      await sb.from("downloads").delete().eq("user_id", Auth.user.id);
    } else {
      localStorage.removeItem(this.GUEST_KEY);
    }
    this.reload();
  },

  async reload() {
    const list = await this.load();
    renderHistory(list);
  },
};

async function renderHistory(list) {
  const section = document.getElementById("history-section");
  const ul = document.getElementById("history-list");
  const note = document.getElementById("history-note");

  if (!list.length) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");

  note.textContent = (authEnabled && Auth.user)
    ? "Saved to your account."
    : "Guest history is stored only in your browser and clears automatically after 24 hours.";

  ul.innerHTML = "";
  for (const r of list) {
    const li = document.createElement("li");
    const when = timeAgo(r.ts);
    li.innerHTML = `
      <div class="hist-main">
        <span class="hist-title">${escapeHtml(r.title || r.url)}</span>
        <span class="hist-sub">${escapeHtml(r.platform || "")}${r.quality ? " · " + escapeHtml(r.quality) : ""} · ${r.mode === "audio" ? "MP3" : "video"} · ${when}</span>
      </div>
      <button class="btn ghost small-btn again-btn" data-url="${escapeHtml(r.url)}">↻ again</button>
    `;
    li.querySelector(".again-btn").addEventListener("click", () => {
      document.getElementById("url").value = r.url;
      document.getElementById("url-form").dispatchEvent(new Event("submit", { cancelable: true }));
    });
    ul.appendChild(li);
  }
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

document.getElementById("clear-history").addEventListener("click", () => History.clear());

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
