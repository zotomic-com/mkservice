const REPO = "zotomic-com/freedownloder";
const token = process.env.GH_TOKEN;
const headers = token ? { Authorization: `token ${token}` } : {};

(async () => {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}`, { headers });
    if (r.ok) {
      const j = await r.json();
      console.log(`Repo visibility: ${j.visibility} (private = ${j.private})`);
    } else if (r.status === 401) {
      console.log("TOKEN INVALID (401) — you likely rotated it already. Good for security.");
    } else if (r.status === 404) {
      console.log("Repo is PRIVATE or unreachable without a valid token.");
    } else {
      console.log(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
  } catch (e) {
    console.log(`Request failed: ${e.message}`);
  }
})();
