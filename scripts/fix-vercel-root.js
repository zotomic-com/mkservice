/**
 * Inspect + fix the Vercel project settings that break routing.
 * Token via env VERCEL_TOKEN.
 */
const TEAM_ID = "zotomic-com-5624s-projects";
const PROJECT_ID = "prj_iy0CWaSOShPotlggzOO8NKv0Mtab";
const AUTH = { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, "Content-Type": "application/json" };
const base = `https://api.vercel.com/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`;

(async () => {
  const p = await fetch(base, { headers: AUTH }).then((r) => r.json());
  console.log("Current settings:");
  console.log(`  framework:      ${p.framework}`);
  console.log(`  rootDirectory:  ${p.rootDirectory}`);
  console.log(`  buildCommand:   ${p.buildCommand}`);
  console.log(`  outputDirectory:${p.outputDirectory}`);

  if (p.rootDirectory) {
    const res = await fetch(base, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ rootDirectory: null, framework: null }),
    });
    console.log(res.ok ? "PATCH OK — rootDirectory removed ✓" : `PATCH FAILED: ${res.status}`);
  } else {
    console.log("rootDirectory is already empty — no patch needed.");
  }
})();
