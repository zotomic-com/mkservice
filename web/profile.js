/* own downloader — Profile pane (name, email, password) */

function renderProfile() {
  const signedOut = document.getElementById("profile-signed-out");
  const panel = document.getElementById("profile-panel");
  if (!signedOut || !panel) return;

  const active = authEnabled && Auth.user;
  signedOut.classList.toggle("hidden", !!active);
  panel.classList.toggle("hidden", !active);
  if (!active) return;

  document.getElementById("pf-email-current").textContent = Auth.user.email || "";
  document.getElementById("pf-name").value = Auth.name || "";
  document.getElementById("pf-pass").value = "";
  setHint("pf-name-msg", "");
  setHint("pf-email-msg", "");
  setHint("pf-pass-msg", "");
}

function setHint(id, msg, ok = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok ? "var(--good)" : msg ? "var(--bad)" : "";
}

document.getElementById("profile-signin")?.addEventListener("click", openAuthModal);

/* Display name */
document.getElementById("pf-name-save")?.addEventListener("click", async () => {
  const name = document.getElementById("pf-name").value.trim();
  if (!name) { setHint("pf-name-msg", "Enter a name first."); return; }
  try {
    await Auth.updateName(name);
    setHint("pf-name-msg", "✓ Name updated", true);
    renderAuthArea();
  } catch (err) {
    setHint("pf-name-msg", err.message || "Failed.");
  }
});

/* Email change (sends confirmation to the new address) */
document.getElementById("pf-email-save")?.addEventListener("click", async () => {
  const email = document.getElementById("pf-email").value.trim();
  if (!email) { setHint("pf-email-msg", "Enter a new email first."); return; }
  try {
    await Auth.updateEmail(email);
    setHint("pf-email-msg", "✓ Confirmation sent to the new email — confirm to finish the change.", true);
  } catch (err) {
    setHint("pf-email-msg", err.message || "Failed.");
  }
});

/* Password change */
document.getElementById("pf-pass-save")?.addEventListener("click", async () => {
  const pass = document.getElementById("pf-pass").value;
  if (pass.length < 6) { setHint("pf-pass-msg", "Password must be at least 6 characters."); return; }
  try {
    await Auth.updatePassword(pass);
    setHint("pf-pass-msg", "✓ Password updated", true);
    document.getElementById("pf-pass").value = "";
  } catch (err) {
    setHint("pf-pass-msg", err.message || "Failed. If the session is old, sign out and back in first.");
  }
});
