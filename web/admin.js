/* own downloader — admin dashboard */

const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

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
  $("signout-btn").addEventListener("click", async () => { await sb.auth.signOut(); location.href = "index.html"; });

  await loadUsers();
  await loadDownloads();
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

async function loadUsers() {
  const res = await fetch(`${CONFIG.API_URL}/api/admin/users`, {
    headers: { Authorization: `Bearer ${(await sb.auth.getSession()).data.session.access_token}` },
  });
  if (!res.ok) { alert("Could not load users: " + (await res.json()).error); return; }
  const users = await res.json();

  $("user-count").textContent = `(${users.length})`;
  const tbody = $("users-table tbody");
  tbody.innerHTML = "";
  for (const u of users) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(u.email)}</td>
      <td><span class="role-pill ${u.role}">${u.role}</span></td>
      <td>${new Date(u.createdAt).toLocaleDateString()}</td>
      <td>${u.downloads}</td>
      <td class="row-actions">
        <button class="mini-btn" data-act="role" data-id="${u.id}" data-role="${u.role}">${u.role === "admin" ? "Demote" : "Make admin"}</button>
        <button class="mini-btn danger" data-act="del" data-id="${u.id}">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.id;
    if (b.dataset.act === "role") {
      await api("PUT", `/api/admin/users/${id}/role`, { role: b.dataset.role === "admin" ? "user" : "admin" });
      loadUsers();
    } else {
      if (confirm("Delete this user and all their history? This cannot be undone.")) {
        await api("DELETE", `/api/admin/users/${id}`);
        loadUsers();
      }
    }
  }));
}

/* ------------------------------------------------------------------ */
/* Downloads                                                           */
/* ------------------------------------------------------------------ */

async function loadDownloads() {
  const res = await fetch(`${CONFIG.API_URL}/api/admin/downloads`, {
    headers: { Authorization: `Bearer ${(await sb.auth.getSession()).data.session.access_token}` },
  });
  if (!res.ok) { alert("Could not load history: " + (await res.json()).error); return; }
  const rows = await res.json();

  $("dl-count").textContent = `(${rows.length})`;
  const tbody = $("downloads-table tbody");
  tbody.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="dim">${escapeHtml(short(r.profiles?.email) || r.user_id?.slice(0, 8) || "—")}</td>
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
    loadDownloads();
  }));
}

/* ------------------------------------------------------------------ */

async function api(method, path, body) {
  const token = (await sb.auth.getSession()).data.session.access_token;
  const res = await fetch(CONFIG.API_URL + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) alert((await res.json()).error || "Request failed");
  return res.ok;
}

function short(s) { return s && s.length > 22 ? s.slice(0, 20) + "…" : s; }

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

init();
