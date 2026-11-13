/**
 * Fetches recent logs from the Render service to see the real yt-dlp error.
 * Token via env RENDER_TOKEN.
 */
const SERVICE_ID = "srv-dbri5r9srm7s7394mts0";
const AUTH = { Authorization: `Bearer ${process.env.RENDER_TOKEN}` };

(async () => {
  const qs = new URLSearchParams({
    serviceId: SERVICE_ID,
    limit: "40",
  });
  const res = await fetch(`https://api.render.com/v1/logs?${qs}`, { headers: AUTH });
  const body = await res.json();
  if (!res.ok) { console.log(`FAILED ${res.status}: ${JSON.stringify(body).slice(0, 500)}`); return; }
  const logs = (body || []).map((x) => x.log || x).filter(Boolean);
  // Show lines with errors or recent activity
  for (const l of logs) {
    const s = typeof l === "string" ? l : JSON.stringify(l);
    console.log(s.slice(0, 300));
  }
})();
