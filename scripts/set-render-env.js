/**
 * Updates an environment variable on the Render service.
 * Usage: node scripts/set-render-env.js KEY VALUE
 * Token via env RENDER_TOKEN.
 */
const RENDER_TOKEN = process.env.RENDER_TOKEN;
const SERVICE_ID = "srv-dbri5r9srm7s7394mts0";

const [key, value] = process.argv.slice(2);
if (!key || value === undefined) {
  console.log("usage: node scripts/set-render-env.js KEY VALUE");
  process.exit(1);
}

(async () => {
  // Fetch current env vars, replace/create the one we need
  const list = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
    headers: { Authorization: `Bearer ${RENDER_TOKEN}` },
  }).then((r) => r.json());

  const envVars = (list || []).map((item) => ({
    key: item.envVar.key,
    value: item.envVar.value,
  }));

  const existing = envVars.find((e) => e.key === key);
  if (existing) existing.value = value;
  else envVars.push({ key, value });

  // Replace the full list (API requires full replacement)
  const del = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${RENDER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(envVars),
  });
  console.log(del.ok ? `ENV UPDATED: ${key} ✓ (service will restart)` : `FAILED ${del.status}: ${await del.text()}`);
})();
