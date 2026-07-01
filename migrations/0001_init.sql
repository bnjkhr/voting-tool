-- Neon-Migration 0001: Initiales SaaS-Schema (Firestore -> Postgres).
-- Legacy-Daten bleiben in Firestore; hier nur Nicht-Legacy-Tenants.
-- IDs sind text (= bisherige Firestore-Doc-IDs), damit die Datenmigration
-- ohne ID-Remapping funktioniert. Neue Zeilen: gen_random_uuid()::text.

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email

create table tenants (
  id                     text primary key,       -- = slug
  name                   text not null,
  display_name           text,
  slug                   text unique not null,
  status                 text not null default 'active'
                           check (status in ('active','suspended','trialing','past_due','canceled')),
  email_from_name        text,
  email_reply_to         text,
  -- Billing (fuer Stripe / PR 3b vorbereitet):
  plan                   text,
  stripe_customer_id     text unique,
  stripe_subscription_id text,
  subscription_status    text,
  trial_ends_at          timestamptz,
  current_period_end     timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table apps (
  id                 text primary key,
  tenant_id          text not null references tenants(id) on delete cascade,
  name               text not null,
  description        text not null default '',
  slug               text not null,
  ticket_prefix      text,
  labels             text[] not null default '{}',
  next_ticket_number int  not null default 1,     -- ersetzt collection 'counters'
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index apps_tenant_idx on apps (tenant_id);

create table releases (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  app_id       text not null references apps(id) on delete cascade,
  version      text,
  title        text not null,
  description  text not null default '',
  status       text not null default 'geplant'
                 check (status in ('geplant','in Arbeit','veröffentlicht')),
  release_date timestamptz,
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index releases_app_status_idx on releases (app_id, status);

create table suggestions (
  id                   text primary key,
  tenant_id            text not null references tenants(id) on delete cascade,
  app_id               text not null references apps(id) on delete cascade,
  type                 text not null check (type in ('feature','bug','ticket')),
  title                text not null,
  description          text not null default '',
  status               text not null default 'neu',
  priority             text check (priority in ('niedrig','mittel','hoch','kritisch')),
  labels               text[] not null default '{}',
  tag                  text,
  tag_updated_at       timestamptz,
  votes                int  not null default 0,   -- denormalisierter Zaehler
  approved             bool not null default false,
  approved_at          timestamptz,
  release_id           text references releases(id) on delete set null,
  ticket_number        text,
  user_fingerprint     text,
  notification_enabled bool not null default false,
  notification_email   text,
  -- Bug-spezifisch:
  severity             text check (severity in ('low','medium','high','critical')),
  steps_to_reproduce   text,
  expected_behavior    text,
  actual_behavior      text,
  environment          jsonb,                     -- {appVersion, platform, browser}
  created_at           timestamptz not null default now()
);
create index suggestions_app_approved_idx on suggestions (app_id, approved);
create index suggestions_tenant_idx       on suggestions (tenant_id);
create index suggestions_release_idx      on suggestions (release_id);

create table votes (
  id               text primary key,
  tenant_id        text not null references tenants(id) on delete cascade,
  suggestion_id    text not null references suggestions(id) on delete cascade,
  user_fingerprint text not null,
  created_at       timestamptz not null default now(),
  unique (suggestion_id, user_fingerprint)        -- 1 Vote/Fingerprint DB-seitig
);

create table comments (
  id                 text primary key,
  tenant_id          text not null references tenants(id) on delete cascade,
  suggestion_id      text not null references suggestions(id) on delete cascade,
  text               text not null,
  author_type        text not null check (author_type in ('admin','user')),
  author_fingerprint text,
  approval_status    text not null default 'pending'
                       check (approval_status in ('pending','approved','rejected')),
  approved_at        timestamptz,
  approved_by        text,
  rejected_at        timestamptz,
  rejected_by        text,
  created_at         timestamptz not null default now()
);
create index comments_suggestion_status_idx on comments (suggestion_id, approval_status);

create table attachments (                        -- ersetzt base64 screenshots[]
  id           uuid primary key default gen_random_uuid(),
  tenant_id    text not null references tenants(id) on delete cascade,
  parent_type  text not null check (parent_type in ('suggestion','comment')),
  parent_id    text not null,
  storage_key  text not null,
  content_type text,
  size_bytes   int,
  created_at   timestamptz not null default now()
);
create index attachments_parent_idx on attachments (parent_type, parent_id);

create table activity (
  id         bigint generated always as identity primary key,
  tenant_id  text not null,
  ticket_id  text not null,                       -- -> suggestions.id
  action     text not null,
  old_value  text,
  new_value  text,
  detail     text,
  actor      text,
  created_at timestamptz not null default now()
);
create index activity_ticket_idx on activity (ticket_id, created_at);

create table users (
  id           text primary key,
  email        citext unique not null,
  display_name text,
  status       text not null default 'active' check (status in ('active','disabled')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table memberships (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  role        text not null check (role in ('owner','admin','viewer')),
  status      text not null default 'active' check (status in ('active','disabled')),
  disabled_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index memberships_user_status_idx on memberships (user_id, status);

create table invites (
  id          text primary key,
  tenant_id   text not null references tenants(id) on delete cascade,
  email       citext not null,
  role        text not null check (role in ('owner','admin','viewer')),
  status      text not null default 'pending'
                check (status in ('pending','accepted','revoked','expired')),
  token_hash  text not null,
  expires_at  timestamptz,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index invites_tenant_status_idx on invites (tenant_id, status);
create index invites_token_idx         on invites (token_hash);

create table sessions (
  id           text primary key,
  user_id      text not null references users(id) on delete cascade,
  status       text not null default 'active',
  token_hash   text unique not null,
  last_used_at timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table login_links (
  id           text primary key,
  email        citext not null,
  status       text not null default 'pending',
  token_hash   text unique not null,
  redirect_url text,
  expires_at   timestamptz,
  consumed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table api_keys (
  id           text primary key,
  tenant_id    text not null references tenants(id) on delete cascade,
  name         text not null,
  scopes       text[] not null default '{}',
  token_hash   text unique not null,
  token_prefix text,
  created_by   text,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
