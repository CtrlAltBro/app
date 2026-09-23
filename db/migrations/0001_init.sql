-- ============================================================
-- Better Auth (core tables, email + password)
-- Mirrors the schema Better Auth expects with its default Postgres adapter.
-- Regenerate with `npx @better-auth/cli generate` if plugins are added.
-- ============================================================

create table "user" (
  "id" text primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);

create table "session" (
  "id" text primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade
);
create index "session_userId_idx" on "session" ("userId");

create table "account" (
  "id" text primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null
);
create index "account_userId_idx" on "account" ("userId");

create table "verification" (
  "id" text primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default current_timestamp,
  "updatedAt" timestamptz not null default current_timestamp
);
create index "verification_identifier_idx" on "verification" ("identifier");

-- ============================================================
-- App
-- ============================================================

-- A monitored PC. The agent authenticates with its own long-lived token
-- (only the hash is stored), never with the parent's account.
create table devices (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  name text not null,
  token_hash text unique,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create index devices_user_id_idx on devices (user_id);

-- One-time codes generated from the dashboard to pair a new PC.
-- The agent exchanges a valid code for a device token.
create table pairing_codes (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references "user" ("id") on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references devices (id) on delete set null,
  created_at timestamptz not null default now()
);
create index pairing_codes_user_id_idx on pairing_codes (user_id);

create table installed_apps (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete cascade,
  app_name text not null,
  exe_path text,
  last_seen_at timestamptz not null default now()
);
create index installed_apps_device_id_idx on installed_apps (device_id);

create table screen_time_sessions (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete cascade,
  app_name text not null,
  window_title text,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_seconds int
);
create index screen_time_sessions_device_started_idx on screen_time_sessions (device_id, started_at desc);

create table browser_history (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete cascade,
  browser text not null,
  url text not null,
  title text,
  visited_at timestamptz not null
);
create index browser_history_device_visited_idx on browser_history (device_id, visited_at desc);

create table block_rules (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete cascade,
  type text not null check (type in ('app', 'site')),
  target text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (device_id, type, target)
);

create table commands (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id) on delete cascade,
  type text not null,
  payload jsonb,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  created_at timestamptz not null default now(),
  executed_at timestamptz
);
-- The agent polls only its pending commands.
create index commands_pending_idx on commands (device_id, created_at) where status = 'pending';
