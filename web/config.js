/**
 * own downloader — deployment configuration
 *
 * LOCAL USE (the app running on your own PC):
 *   Leave everything as-is below. API_URL points at your local server.
 *
 * PUBLIC DEPLOYMENT (Vercel + Railway + Supabase):
 *   1. API_URL          -> your Railway API URL, e.g. "https://own-downloader-api.up.railway.app"
 *   2. SUPABASE_URL     -> e.g. "https://abcdefgh.supabase.co"
 *   3. SUPABASE_ANON_KEY-> Supabase > Settings > API > anon public key
 */
const CONFIG = {
  // Backend (download engine) — deployed on Render
  API_URL: "https://freedownloder-api.onrender.com",

  // Supabase (public values only — safe to ship to the browser)
  SUPABASE_URL: "https://cqezvhutoiowqbxisonb.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_1rhhEE7NY6hk79Yi3sc4Zw_3pzvuU3R",
};
