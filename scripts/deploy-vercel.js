/**
 * Deploys the web/ folder to the existing Vercel project "freedownloder"
 * via the REST API. Token via env VERCEL_TOKEN (never written to disk).
 */
const fs = require("fs");
const path = require("path");

const TEAM_ID = "zotomic-com-5624s-projects";
const PROJECT = "mkservice";
const WEB_DIR = path.join(__dirname, "..", "web");

const FILES = ["index.html", "style.css", "app.js", "auth.js", "config.js", "admin.html", "admin.js"];

const files = FILES.map((f) => ({
  file: f,
  data: fs.readFileSync(path.join(WEB_DIR, f), "utf8"),
  encoding: "utf-8",
}));

const payload = {
  name: PROJECT,
  target: "production",
  files,
  projectSettings: { framework: null },
};

const qs = new URLSearchParams({ teamId: TEAM_ID, skipAutoDetectionConfirmation: "1" });

fetch(`https://api.vercel.com/v13/deployments?${qs}`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(payload),
}).then(async (res) => {
  const body = await res.json();
  if (!res.ok) {
    console.log(`DEPLOY FAILED (${res.status})`);
    console.log(JSON.stringify(body).slice(0, 1500));
    return;
  }
  console.log(`Deployment created: ${body.id}`);
  console.log(`URL: https://${body.url}`);

  // Poll until ready
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const d = await fetch(`https://api.vercel.com/v13/deployments/${body.id}?teamId=${TEAM_ID}`, {
      headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
    }).then((r) => r.json());
    if (d.readyState === "READY" && d.status === "READY") {
      console.log("DEPLOY READY ✓");
      console.log(`Production URL: https://${(d.alias || []).join(", https://")}`);
      return;
    }
    if (d.status === "ERROR" || d.status === "CANCELED") {
      console.log(`DEPLOY ${d.status}`);
      console.log(JSON.stringify(d.errorMessage || d).slice(0, 1000));
      return;
    }
  }
  console.log("Still building after 2 minutes — check the Vercel dashboard.");
});
