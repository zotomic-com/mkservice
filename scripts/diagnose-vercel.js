/**
 * Diagnose why the production URL 404s.
 * Token via env VERCEL_TOKEN.
 */
const TEAM_ID = "zotomic-com-5624s-projects";
const PROJECT_ID = "prj_iy0CWaSOShPotlggzOO8NKv0Mtab";
const H = { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` };

(async () => {
  // 1. Recent deployments
  const d = await fetch(
    `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&limit=6`,
    { headers: H }
  ).then((r) => r.json());

  console.log("Recent deployments:");
  for (const dep of d.deployments || []) {
    console.log(`  ${dep.uid}  state=${dep.readyState}  target=${dep.target || "-"}  created=${new Date(dep.createdAt).toISOString()}`);
    console.log(`     url: ${dep.url}`);
    console.log(`     aliases: ${(dep.alias || []).join(", ") || "(none)"}`);
  }

  // 2. Live check
  try {
    const r = await fetch("https://freedownloder-ecru.vercel.app");
    console.log(`\nLive check freedownloder-ecru.vercel.app -> HTTP ${r.status}`);
  } catch (e) {
    console.log(`\nLive check failed: ${e.message}`);
  }
})();
