/**
 * Lists Render services and their deploy status.
 * Token via env RENDER_TOKEN.
 */
const AUTH = { Authorization: `Bearer ${process.env.RENDER_TOKEN}` };

(async () => {
  const list = await fetch("https://api.render.com/v1/services?limit=5", { headers: AUTH }).then((r) => r.json());
  for (const item of list || []) {
    const s = item.service;
    console.log(`service: ${s.id}`);
    console.log(`  name:      ${s.name}`);
    console.log(`  url:       ${s.serviceDetails?.url || "(pending)"}`);
    console.log(`  suspended: ${s.suspended}`);
  }
  if (!(list || []).length) console.log("no services found");

  // Latest deploys for the first service
  if ((list || []).length) {
    const sid = list[0].service.id;
    const deploys = await fetch(`https://api.render.com/v1/services/${sid}/deploys?limit=3`, { headers: AUTH }).then((r) => r.json());
    console.log("\nRecent deploys:");
    for (const d of deploys || []) {
      console.log(`  ${d.deploy.id}  status=${d.deploy.status}  created=${d.deploy.createdAt}`);
    }
  }
})();
