-- ============================================================
-- own downloader — Supabase schema
-- Run this in the Supabase SQL Editor (once per project)
--
-- Design:
--   * Video FILES are never stored. Only download-history LINKS/metadata.
--   * Guests: history lives in the browser (localStorage), auto-deleted after 24h.
--   * Logged-in users: history rows in `downloads`, visible only to them.
--   * Admins (profiles.role = 'admin') can manage users + all history.
-- ============================================================

-- ---------- profiles (one row per auth user) ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        text not null default 'user' check (role in ('user', 'admin')),
  created_at  timestamptz not null default now()
);

-- Auto-create a profile whenever a user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- download history (metadata / links only) ----------
create table if not exists public.downloads (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  url         text not null,
  title       text not null default 'Untitled',
  platform    text not null default '',
  quality     text not null default '',
  mode        text not null default 'video',   -- 'video' | 'audio'
  created_at  timestamptz not null default now()
);

create index if not exists downloads_user_idx on public.downloads (user_id, created_at desc);

-- ---------- Row Level Security ----------
alter table public.profiles enable row level security;
alter table public.downloads enable row level security;

-- Everyone can read their own profile
drop policy if exists "read own profile" on public.profiles;
create policy "read own profile" on public.profiles
  for select using (auth.uid() = id);

-- Users see only their own history; admins see everything
drop policy if exists "read own downloads" on public.downloads;
create policy "read own downloads" on public.downloads
  for select using (
    auth.uid() = user_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

drop policy if exists "insert own downloads" on public.downloads;
create policy "insert own downloads" on public.downloads
  for insert with check (auth.uid() = user_id);

drop policy if exists "delete own downloads" on public.downloads;
create policy "delete own downloads" on public.downloads
  for delete using (
    auth.uid() = user_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
  );

-- ---------- helper: is the current user an admin? ----------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ---------- promote your own account to admin ----------
-- After you register your first account, find its id and run:
--   update public.profiles set role = 'admin' where id = '<your-user-id>';
-- (Only run this once, for yourself. Keep the SQL editor private.)
