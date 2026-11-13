/**
 * Sets rootDirectory=web so GitHub auto-deploys build the frontend,
 * matching the repo layout (frontend lives in web/).
 * Token via env VERCEL_TOKEN.
 */
const TEAM_ID = "zotomic-com-5624s-projects";
const PROJECT_ID = "prj_iy0CWaSOShPotlggzOO8NKv0Mtab";

fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}?teamId=${TEAM_ID}`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ rootDirectory: "web", framework: null }),
}).then(async (res) => {
  const body = await res.json();
  console.log(res.ok ? `PATCH OK — rootDirectory now: ${body.rootDirectory}` : `PATCH FAILED ${res.status}: ${JSON.stringify(body)}`);
});
