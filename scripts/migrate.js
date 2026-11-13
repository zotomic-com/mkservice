/**
 * Runs supabase/schema.sql against the linked Supabase project
 * via the Management API. Token is passed as env var SUPA_TOKEN
 * and is never written to disk.
 */
const fs = require("fs");

const PROJECT_REF = "cqezvhutoiowqbxisonb";
const sql = fs.readFileSync("supabase/schema.sql", "utf8");

fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.SUPA_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query: sql }),
}).then(async (res) => {
  const text = await res.text();
  console.log(res.ok ? "MIGRATION OK" : `MIGRATION FAILED (${res.status})`);
  console.log(text.slice(0, 2000));
});
