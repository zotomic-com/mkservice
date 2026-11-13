/**
 * Waits for the Render deploy to finish building, then live-checks the API.
 * Token via env RENDER_TOKEN.
 */
const RENDER_TOKEN = process.env.RENDER_TOKEN;
const SERVICE_ID = "srv-dbri5r9srm7s7394mts0";
const API_URL = "https://freedownloder-api.onrender.com";
const AUTH = { Authorization: `Bearer ${RENDER_TOKEN}` };

(async () => {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 10000));
    const deploys = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/deploys?limit=1`, { headers: AUTH })
      .then((r) => r.json());
    const d = (deploys || [])[0]?.deploy;
    if (!d) { console.log("no deploy yet…"); continue; }
    console.log(`deploy status: ${d.status} (${new Date(d.createdAt).toISOString()})`);

    if (d.status === "live") {
      // Verify the API responds
      try {
        const c = await fetch(`${API_URL}/api/config`);
        console.log(`API CHECK: /api/config -> ${JSON.stringify(await c.json())}`);
        const home = await fetch(API_URL);
        console.log(`API CHECK: / -> HTTP ${home.status}`);
        console.log("ENGINE IS LIVE ✓");
      } catch (e) {
        console.log(`API responded but check failed: ${e.message}`);
      }
      return;
    }
    if (["build_failed", "deploy_failed", "canceled", "deactivated"].includes(d.status)) {
      console.log(`DEPLOY FAILED: ${d.status}`);
      return;
    }
  }
  console.log("timed out after 15 minutes");
})();
