/* own downloader — auth & account management (Supabase, optional) */

const authEnabled = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_ANON_KEY);
const sb = authEnabled
  ? window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY)
  : null;

const Auth = {
  user: null,
  isAdmin: false,

  get name() {
    return this.user?.user_metadata?.name || "";
  },

  async init() {
    if (!authEnabled) { renderAuthArea(); return; }
    const { data } = await sb.auth.getSession();
    this.user = data?.session?.user || null;
    await this.refreshRole();

    sb.auth.onAuthStateChange(async (event) => {
      const { data: d } = await sb.auth.getSession();
      this.user = d?.session?.user || null;
      await this.refreshRole();
      renderAuthArea();
      History.reload();
      // Password recovery email link opens the app with recovery tokens
      if (event === "PASSWORD_RECOVERY") openRecovery();
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

  async sendResetEmail(email) {
    const redirectTo = window.location.origin + "/index.html";
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  },

  async updatePassword(newPass) {
    const { error } = await sb.auth.updateUser({ password: newPass });
    if (error) throw error;
  },

  async updateName(name) {
    const { error } = await sb.auth.updateUser({ data: { name } });
    if (error) throw error;
  },

  async updateEmail(email) {
    const { error } = await sb.auth.updateUser({ email });
    if (error) throw error;
  },

  async signOut() {
    await sb.auth.signOut();
    this.user = null;
    this.isAdmin = false;
  },
};

/* ------------------------------------------------------------------ */
/* Sidebar auth area                                                   */
/* ------------------------------------------------------------------ */

const LOGOUT_SVG = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;

function renderAuthArea() {
  const area = document.getElementById("auth-area");
  const adminLink = document.getElementById("nav-admin");
  if (!area) return;

  if (!authEnabled) {
    area.innerHTML = `<p class="side-auth-note">Local mode — no accounts needed.</p>`;
    if (adminLink) adminLink.classList.add("hidden");
    return;
  }

  if (adminLink) adminLink.classList.toggle("hidden", !Auth.isAdmin);

  if (!Auth.user) {
    area.innerHTML = `<button id="open-auth" class="btn primary full">Sign in</button>`;
    document.getElementById("open-auth")?.addEventListener("click", openAuthModal);
    return;
  }

  const initial = (Auth.name || Auth.user.email || "A").trim().charAt(0).toUpperCase();
  area.innerHTML = `
    <div class="side-foot-row">
      <div class="side-user">
        <span class="avatar">${escapeHtml(initial)}</span>
        <div class="side-user-meta">
          <strong>${escapeHtml(Auth.name || "Account")}</strong>
          <span>${escapeHtml(Auth.user.email || "")}</span>
        </div>
      </div>
      <button id="signout-btn" class="icon-round logout" title="Sign out" aria-label="Sign out">${LOGOUT_SVG}</button>
    </div>
  `;
  document.getElementById("signout-btn")?.addEventListener("click", Auth.signOut.bind(Auth));
}

/* ------------------------------------------------------------------ */
/* Eye (show/hide password) helper                                     */
/* ------------------------------------------------------------------ */

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".eye-btn");
  if (!btn) return;
  const input = document.getElementById(btn.dataset.eye);
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
  btn.textContent = input.type === "password" ? "👁" : "🙈";
});

/* ------------------------------------------------------------------ */
/* Auth modal: sign in / sign up / forgot / recovery                   */
/* ------------------------------------------------------------------ */

function openAuthModal() {
  showAuthView("main");
  document.getElementById("auth-modal").classList.remove("hidden");
  setAuthError("");
}

function closeAuthModal() {
  document.getElementById("auth-modal").classList.add("hidden");
}

function showAuthView(view) {
  ["auth-main", "auth-forgot", "auth-recovery"].forEach((id) =>
    document.getElementById(id).classList.toggle("hidden", id !== "auth-" + view));
}

function setAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (msg) { el.textContent = msg; el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

document.getElementById("auth-close")?.addEventListener("click", closeAuthModal);
document.getElementById("auth-modal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeAuthModal();
});

document.getElementById("tab-signin")?.addEventListener("click", () => switchTab(true));
document.getElementById("tab-signup")?.addEventListener("click", () => switchTab(false));

function switchTab(signin) {
  document.getElementById("tab-signin").classList.toggle("active", signin);
  document.getElementById("tab-signup").classList.toggle("active", !signin);
  document.getElementById("auth-submit").textContent = signin ? "Sign in" : "Create account";
  setAuthError("");
}

document.getElementById("auth-form")?.addEventListener("submit", async (e) => {
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

/* Forgot password */
document.getElementById("forgot-link")?.addEventListener("click", () => showAuthView("forgot"));
document.getElementById("forgot-back")?.addEventListener("click", () => showAuthView("main"));

document.getElementById("forgot-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!authEnabled) return;
  const email = document.getElementById("forgot-email").value.trim();
  const errEl = document.getElementById("forgot-error");
  const btn = document.getElementById("forgot-submit");
  btn.disabled = true;
  errEl.classList.add("hidden");
  try {
    await Auth.sendResetEmail(email);
    errEl.textContent = "✓ Reset link sent! Check your inbox (and spam folder).";
    errEl.classList.remove("hidden");
    errEl.style.color = "var(--good)";
  } catch (err) {
    errEl.textContent = err.message || "Could not send reset email.";
    errEl.classList.remove("hidden");
    errEl.style.color = "";
  } finally {
    btn.disabled = false;
  }
});

/* Recovery (opens via the email link) */
function openRecovery() {
  if (!authEnabled) return;
  showAuthView("recovery");
  document.getElementById("auth-modal").classList.remove("hidden");
}

document.getElementById("recovery-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!authEnabled) return;
  const pass = document.getElementById("recovery-pass").value;
  const errEl = document.getElementById("recovery-error");
  const btn = document.getElementById("recovery-submit");
  btn.disabled = true;
  errEl.classList.add("hidden");
  try {
    await Auth.updatePassword(pass);
    errEl.textContent = "✓ Password updated! You're signed in.";
    errEl.classList.remove("hidden");
    errEl.style.color = "var(--good)";
    renderAuthArea();
    setTimeout(closeAuthModal, 1200);
  } catch (err) {
    errEl.textContent = err.message || "Could not update password.";
    errEl.classList.remove("hidden");
    errEl.style.color = "";
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
  if (!section || !ul) return;

  if (!list.length) { section.classList.add("hidden"); return; }
  section.classList.remove("hidden");

  note.textContent = (authEnabled && Auth.user)
    ? "Saved to your account."
    : "Guest history is stored only in your browser and clears automatically after 24 hours.";

  ul.innerHTML = "";
  for (const r of list) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="hist-main">
        <span class="hist-title">${escapeHtml(r.title || r.url)}</span>
        <span class="hist-sub">${escapeHtml(r.platform || "")}${r.quality ? " · " + escapeHtml(r.quality) : ""} · ${r.mode === "audio" ? "MP3" : "video"} · ${timeAgo(r.ts)}</span>
      </div>
      <button class="btn ghost small-btn again-btn" data-url="${escapeHtml(r.url)}">↻ again</button>
    `;
    li.querySelector(".again-btn")?.addEventListener("click", () => {
      const urlInput = document.getElementById("url");
      if (!urlInput) return;
      urlInput.value = r.url;
      switchPane("dl");
      document.getElementById("url-form")?.dispatchEvent(new Event("submit", { cancelable: true }));
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

document.getElementById("clear-history")?.addEventListener("click", () => History.clear());

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
