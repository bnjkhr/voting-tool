-- Verknüpfungen interner Tickets mit öffentlichen Einträgen (Stufe 1).
-- feedback_sources: welches Board eines privaten Workspaces aus welcher
-- öffentlichen Quelle holt. feedback_links: je öffentlichem Eintrag höchstens
-- eine Zeile. Eine Zeile ohne Ticket (gelöscht oder gelöst) bleibt als
-- Grabstein stehen, damit der Eintrag nicht erneut geholt wird.
-- Rein additiv: Ältere Code-Stände kennen beide Tabellen nicht.

create table feedback_sources (
  id               text primary key default gen_random_uuid()::text,
  tenant_id        text not null references tenants(id) on delete cascade,   -- privater Ziel-Workspace
  app_id           text not null unique references apps(id) on delete cascade, -- Ziel-Board
  source_kind      text not null check (source_kind in ('legacy','workspace')),
  source_tenant_id text,                          -- null bei legacy
  source_app_id    text not null,                 -- Firestore-App-ID oder apps.id
  fetch_enabled    bool not null default false,
  last_fetched_at  timestamptz,
  unapproved_count int not null default 0,
  last_error       text,
  created_at       timestamptz not null default now(),
  check ((source_kind = 'legacy') = (source_tenant_id is null))
);
create unique index feedback_sources_source_uidx
  on feedback_sources (source_kind, coalesce(source_tenant_id, ''), source_app_id);

create table feedback_links (
  id             text primary key default gen_random_uuid()::text,
  tenant_id      text not null references tenants(id) on delete cascade,
  source_id      text not null references feedback_sources(id) on delete cascade,
  entry_id       text not null,
  suggestion_id  text unique references suggestions(id) on delete set null, -- null = Grabstein
  public_type    text,
  public_status  text,
  public_approved bool,
  public_deleted bool not null default false,
  public_seen_at timestamptz,
  pending_status text,                            -- Stufe 2, bleibt hier null
  created_at     timestamptz not null default now(),
  unique (source_id, entry_id)
);
create index feedback_links_tenant_idx on feedback_links (tenant_id);
