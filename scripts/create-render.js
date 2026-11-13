/**
 * Creates the Render web service (Docker) for the download engine.
 * Token via env RENDER_TOKEN — never written to disk.
 */
const RENDER_TOKEN = process.env.RENDER_TOKEN;
const AUTH = { Authorization: `Bearer ${RENDER_TOKEN}`, "Content-Type": "application/json" };

const payload = {
  type: "web_service",
  name: "freedownloder-api",
  repo: "https://github.com/zotomic-com/freedownloder",
  branch: "main",
  autoDeploy: "yes",
  envVars: [
    { key: "MODE", value: "public" },
    { key: "SUPABASE_URL", value: "https://cqezvhutoiowqbxisonb.supabase.co" },
    { key: "SUPABASE_SERVICE_ROLE_KEY", value: process.env.SUPA_SECRET },
    { key: "ALLOWED_ORIGIN", value: "https://freedownloder-ecru.vercel.app" },
  ],
  serviceDetails: {
    env: "docker",
    region: "oregon",
    plan: "free",
    dockerfilePath: "./Dockerfile",
    dockerContext: "./",
  },
};

(async () => {
  // Resolve the workspace (owner) automatically
  const owners = await fetch("https://api.render.com/v1/owners", { headers: AUTH }).then((r) => r.json());
  const owner = (owners || []).find((o) => o.owner)?.owner;
  if (!owner) {
    console.log("Could not resolve owner:", JSON.stringify(owners).slice(0, 500));
    return;
  }
  console.log(`Workspace: ${owner.name} (${owner.id})`);
  payload.ownerId = owner.id;

  const res = await fetch("https://api.render.com/v1/services", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) {
    console.log(`CREATE FAILED (${res.status})`);
    console.log(JSON.stringify(body).slice(0, 1500));
    return;
  }
  console.log("SERVICE CREATED ✓");
  console.log(`id: ${body.id}`);
  console.log(`url: ${body.serviceDetails?.url || "(pending)"}`);
  console.log(`dashboard: ${body.dashboardUrl || ""}`);
})();
