const PROJECT_REF = "cqezvhutoiowqbxisonb";
const q = "select table_name from information_schema.tables where table_schema = 'public' order by table_name";
fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${process.env.SUPA_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: q }),
}).then(async (r) => console.log((await r.text()).slice(0, 1000)));
