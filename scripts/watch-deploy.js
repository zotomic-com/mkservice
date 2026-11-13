/**
 * Waits for the newest GitHub-triggered deployment to go READY,
 * then live-checks the production URL.
 * Token via env VERCEL_TOKEN.
 */
const TEAM_ID = "zotomic-com-5624s-projects";
const PROJECT_ID = "prj_iy0CWaSOShPotlggzOO8NKv0Mtab";
const H = { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` };

(async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const d = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&teamId=${TEAM_ID}&limit=1&state=READY,ERROR,BUILDING,INITIALIZING,CANCELED`,
      { headers: H }
    ).then((r) => r.json());
    const dep = (d.deployments || [])[0];
    if (!dep) { console.log("no deployments yet…"); continue; }
    console.log(`latest: ${dep.uid} state=${dep.readyState} target=${dep.target || "-"} (${new Date(dep.createdAt).toISOString()})`);
    if (dep.readyState === "READY" && dep.target === "production" && dep.createdAt > Date.now() - 20 * 60 * 1000) {
      for (const url of ["https://freedownloder-ecru.vercel.app", `https://${dep.url}`]) {
        try {
          const r = await fetch(url);
          const txt = await r.text();
          console.log(`${url} -> HTTP ${r.status} ${txt.includes("owndownloader") || txt.includes("own") ? "(frontend ✓)" : ""}`);
        } catch (e) { console.log(`${url} -> fetch error ${e.message}`); }
      }
      return;
    }
    if (dep.readyState === "ERROR" || dep.readyState === "CANCELED") {
      console.log("Deployment failed!");
      return;
    }
  }
  console.log("timed out waiting");
})();
