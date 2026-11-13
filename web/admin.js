/* MK Service — admin dashboard: users, details, stats, top downloads */

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

let USERS = [];
let DOWNLOADS = [];

async function init() {
  const { data } = await sb.auth.getSession();
  const user = data?.session?.user;

  if (!user) {
    $("denied").classList.add("hidden");
    $("no-access").classList.remove("hidden");
    return;
  }

  const { data: prof } = await sb.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (prof?.role !== "admin") {
    $("denied").classList.add("hidden");
    $("no-access").classList.remove("hidden");
    return;
  }

  $("denied").classList.add("hidden");
  $("panel").classList.remove("hidden");
  $("signout-btn").classList.remove("hidden");
  $("admin-email").textContent = user.email || "";
  $("signout-btn").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "index.html"; });

  await refresh();
}

async function refresh() {
  const token = await getToken();
  USERS = await fetch(`${CONFIG.API_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json());
  DOWNLOADS = await fetch(`${CONFIG.API_URL}/api/admin/downloads`, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => r.json());

  renderStats();
  renderTop();
  renderUsers();
  renderDownloads();
}

/* ------------------------------------------------------------------ */
/* Stats + top downloads                                               */
/* ------------------------------------------------------------------ */

function renderStats() {
  $("stat-users").textContent = USERS.length;
  $("stat-downloads").textContent = DOWNLOADS.length;
  $("stat-admins").textContent = USERS.filter((u) => u.role === "admin").length;
}

function renderTop() {
  // Most active users
  const byUser = {};
  for (const d of DOWNLOADS) (byUser[d.user_id] = (byUser[d.user_id] || 0) + 1);
  const emailOf = (id) => USERS.find((u) => u.id === id)?.email || id?.slice(0, 8) || "—";
  const topU = Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 5);

  $("top-users").innerHTML = topU.length
    ? topU.map(([id, n]) => `<li>${escapeHtml(short(emailOf(id)))} <span class="dim">· ${n}</span></li>`).join("")
    : '<li class="dim">No downloads yet</li>';

  // Most downloaded platforms
  const byPlatform = {};
  for (const d of DOWNLOADS) if (d.platform) byPlatform[d.platform] = (byPlatform[d.platform] || 0) + 1;
  const topP = Object.entries(byPlatform).sort((a, b) => b[1] - a[1]).slice(0, 5);

  $("top-platforms").innerHTML = topP.length
    ? topP.map(([p, n]) => `<li>${escapeHtml(p)} <span class="dim">· ${n}</span></li>`).join("")
    : '<li class="dim">No downloads yet</li>';
}

/* ------------------------------------------------------------------ */
/* Users table                                                         */
/* ------------------------------------------------------------------ */

function renderUsers() {
  $("user-count").textContent = `(${USERS.length})`;
  const tbody = $("users-table tbody");
  tbody.innerHTML = "";
  for (const u of USERS) {
    const tr = document.createElement("tr");
    tr.className = "clickable";
    tr.innerHTML = `
      <td>${escapeHtml(u.email)}</td>
      <td>${escapeHtml(u.name || "—")}</td>
      <td><span class="role-pill ${u.role}">${u.role}</span></td>
      <td class="dim">${u.lastSignIn ? new Date(u.lastSignIn).toLocaleString() : "never"}</td>
      <td>${u.downloads}</td>
      <td class="row-actions">
        <button class="mini-btn" data-act="role" data-id="${u.id}" data-role="${u.role}">${u.role === "admin" ? "Demote" : "Make admin"}</button>
        <button class="mini-btn" data-act="edit" data-id="${u.id}">Edit</button>
        <button class="mini-btn danger" data-act="del" data-id="${u.id}">Delete</button>
      </td>
    `;
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button")) return;
      showDetails(u.id);
    });
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const id = b.dataset.id;
    const user = USERS.find((u) => u.id === id);
    if (b.dataset.act === "role") {
      await api("PUT", `/api/admin/users/${id}`, { role: b.dataset.role === "admin" ? "user" : "admin" });
      refresh();
    } else if (b.dataset.act === "edit") {
      openUserModal(user);
    } else {
      if (confirm(`Delete ${user.email} and all their history? This cannot be undone.`)) {
        await api("DELETE", `/api/admin/users/${id}`);
        refresh();
      }
    }
  }));
}

/* ------------------------------------------------------------------ */
/* User details                                                        */
/* ------------------------------------------------------------------ */

function showDetails(id) {
  const u = USERS.find((x) => x.id === id);
  if (!u) return;
  const history = DOWNLOADS.filter((d) => d.user_id === id);

  $("details-body").innerHTML = `
    <div class="detail-grid">
      <div><span class="dim">Email</span><br>${escapeHtml(u.email)}</div>
      <div><span class="dim">Name</span><br>${escapeHtml(u.name || "—")}</div>
      <div><span class="dim">Role</span><br><span class="role-pill ${u.role}">${u.role}</span></div>
      <div><span class="dim">User ID</span><br><code>${u.id}</code></div>
      <div><span class="dim">Joined</span><br>${new Date(u.createdAt).toLocaleString()}</div>
      <div><span class="dim">Last sign in</span><br>${u.lastSignIn ? new Date(u.lastSignIn).toLocaleString() : "never"}</div>
      <div><span class="dim">Download records</span><br>${u.downloads}</div>
    </div>
    <h4 style="margin:16px 0 8px">Recent downloads</h4>
    <ul class="top-list">
      ${history.length
        ? history.slice(0, 10).map((d) =>
            `<li>${escapeHtml(d.title || d.url)} <span class="dim">· ${escapeHtml(d.platform)} · ${new Date(d.created_at).toLocaleDateString()}</span></li>`).join("")
        : '<li class="dim">No downloads yet</li>'}
    </ul>
    <div class="actions" style="margin-top:16px">
      <button class="btn ghost small-btn" id="det-edit">✎ Edit user</button>
      <button class="btn danger-btn small-btn" id="det-del">🗑 Delete user</button>
    </div>
  `;

  $("details-modal").classList.remove("hidden");
  $("det-edit").addEventListener("click", () => { closeDetails(); openUserModal(u); });
  $("det-del").addEventListener("click", async () => {
    if (confirm(`Delete ${u.email} and all their history? This cannot be undone.`)) {
      await api("DELETE", `/api/admin/users/${u.id}`);
      closeDetails();
      refresh();
    }
  });
}

function closeDetails() { $("details-modal").classList.add("hidden"); }
$("details-close").addEventListener("click", closeDetails);
$("details-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeDetails(); });

/* ------------------------------------------------------------------ */
/* Add / edit user modal                                               */
/* ------------------------------------------------------------------ */

let editingUser = null;

function openUserModal(user) {
  editingUser = user || null;
  $("user-modal-title").textContent = user ? `Edit: ${user.email}` : "Add user";
  $("um-email").value = user?.email || "";
  $("um-name").value = user?.name || "";
  $("um-pass").value = "";
  $("um-role").value = user?.role || "user";
  $("um-submit").textContent = user ? "Save changes" : "Create user";
  $("um-note").textContent = user
    ? "Leave the password empty to keep it unchanged."
    : "Password is required (min. 6 characters).";
  setUserError("");
  $("user-modal").classList.remove("hidden");
}

function setUserError(msg) {
  const el = $("um-error");
  if (msg) { el.textContent = msg; el.classList.remove("hidden"); } else el.classList.add("hidden");
}

$("add-user-btn").addEventListener("click", () => openUserModal(null));
$("user-modal-close").addEventListener("click", () => $("user-modal").classList.add("hidden"));
$("user-modal").addEventListener("click", (e) => { if (e.target === e.currentTarget) $("user-modal").classList.add("hidden"); });

$("user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("um-email").value.trim();
  const name = $("um-name").value.trim();
  const pass = $("um-pass").value;
  const role = $("um-role").value;

  try {
    if (editingUser) {
      const body = { role };
      if (email && email !== editingUser.email) body.email = email;
      if (pass) body.password = pass;
      if (name !== (editingUser.name || "")) body.name = name;
      await api("PUT", `/api/admin/users/${editingUser.id}`, body);
    } else {
      if (!pass || pass.length < 6) throw new Error("Password must be at least 6 characters.");
      await api("POST", "/api/admin/users", { email, password: pass, role, name });
    }
    $("user-modal").classList.add("hidden");
    refresh();
  } catch (err) {
    setUserError(err.message || "Failed.");
  }
});

/* Eye toggle (password show/hide) */
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".eye-btn");
  if (!btn) return;
  const input = document.getElementById(btn.dataset.eye);
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
  btn.textContent = input.type === "password" ? "👁" : "🙈";
});

/* ------------------------------------------------------------------ */
/* History table                                                       */
/* ------------------------------------------------------------------ */

function renderDownloads() {
  $("dl-count").textContent = `(${DOWNLOADS.length})`;
  const tbody = $("downloads-table tbody");
  tbody.innerHTML = "";
  for (const r of DOWNLOADS) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="dim">${escapeHtml(short(emailOfUser(r.user_id)))}</td>
      <td>${escapeHtml(r.title)}</td>
      <td>${escapeHtml(r.platform)}</td>
      <td>${escapeHtml(r.quality || "best")}</td>
      <td class="dim">${new Date(r.created_at).toLocaleString()}</td>
      <td><button class="mini-btn danger" data-id="${r.id}">Delete</button></td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
    await api("DELETE", `/api/admin/downloads/${b.dataset.id}`);
    refresh();
  }));
}

/* ------------------------------------------------------------------ */

function emailOfUser(id) { return USERS.find((u) => u.id === id)?.email || id?.slice(0, 8) || "—"; }
function short(s) { return s && s.length > 22 ? s.slice(0, 20) + "…" : s; }

async function getToken() {
  return (await sb.auth.getSession()).data.session.access_token;
}

async function api(method, path, body) {
  const token = await getToken();
  const res = await fetch(CONFIG.API_URL + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) alert((await res.json().catch(() => ({}))).error || "Request failed");
  return res.ok;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init();
