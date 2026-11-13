/**
 * Promotes a user to admin in the linked Supabase project.
 * Token via env SUPA_TOKEN.
 */
const PROJECT_REF = "cqezvhutoiowqbxisonb";
const EMAIL = "zotomic.com@gmail.com";
const AUTH = { Authorization: `Bearer ${process.env.SUPA_TOKEN}`, "Content-Type": "application/json" };

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(body));
  return body;
}

(async () => {
  // 1. Does the account exist?
  const users = await query(`select id, email, created_at from auth.users where email = '${EMAIL}'`);
  if (!users.length) {
    console.log("NOT FOUND — you haven't registered on the live site yet.");
    console.log("Sign up at https://freedownloder-ecru.vercel.app first, then I can promote you.");
    return;
  }
  const userId = users[0].id;
  console.log(`Found user: ${users[0].email} (${userId})`);

  // 2. Promote to admin
  const updated = await query(
    `update public.profiles set role = 'admin' where id = '${userId}' returning id, role`
  );
  if (updated.length) {
    console.log(`PROMOTED ✓  role is now: ${updated[0].role}`);
    console.log("Open https://freedownloder-ecru.vercel.app/admin.html to use the dashboard.");
  } else {
    console.log("Auth user exists but no profile row — creating one as admin…");
    const inserted = await query(
      `insert into public.profiles (id, role) values ('${userId}', 'admin') returning id, role`
    );
    console.log(inserted.length ? `PROMOTED ✓  role: ${inserted[0].role}` : "insert failed");
  }
})().catch((e) => console.log("ERROR:", e.message));
