# Migration Firestore → Neon Postgres

**Stand:** 2026-07-01 · **Ziel:** SaaS-Datenhaltung von Firestore auf Neon (serverless Postgres) umstellen, bevor echte Kunden/Skalierung kommen. Grund: vorhersehbares Flat-Pricing statt Pro-Operation, relationale Passung für Billing/Stats, Ende der Full-Collection-Scans.

## 0. Ausgangslage (gemessen)

Gesamter Bestand < 5 MB: 5 Tenants (1 Legacy + 4 SaaS), 150 Suggestions, 74 Votes, 32 Comments, 6 Releases, 6 Apps, 462 Activity, 3 Users/Memberships, 24 Screenshots (1,43 MB). → Datenmigration trivial; das Risiko liegt im **Code-Umbau**, nicht in den Daten.

## 1. Grundsatz-Entscheidungen

1. **Legacy bleibt auf Firestore.** Nur der SaaS-Code (main → roadlight) migriert. Legacy läuft eingefroren auf `legacy-stable` + Firestore weiter (Apps wie GymBo/FamilyManager hängen daran). Damit ist der Migrations-Blast-Radius = nur Nicht-Legacy-Tenants. Der Legacy-Tenant wird **nicht** nach Neon migriert.
2. **IDs bleiben `text` = Firestore-Doc-IDs.** Keine ID-Neuvergabe → alle Fremdschlüssel (tenantId, appId, suggestionId, …) passen 1:1, Datenmigration ohne Remapping. Neue Zeilen: `gen_random_uuid()::text`.
3. **Screenshots raus aus der DB** → Object-Storage (Cloudflare R2 oder Vercel Blob), Referenz per `attachments`-Tabelle. Bei 24 Bildern jetzt billig zu erledigen.
4. **Big-Bang-Cutover** mit kurzem Wartungsfenster (Datenmenge winzig). Firestore bleibt als Rollback erhalten, bis Neon bestätigt läuft.
5. **Query-Layer:** `@neondatabase/serverless` (HTTP-Driver, kein Connection-Pool-Problem auf Vercel) + dünne **Repository-Module** je Entität (`db/tenants.js`, `db/suggestions.js`, …). Kein ORM (Projekt ist Vanilla-JS). Migrations als nummerierte `.sql` in `migrations/` + kleiner Runner (analog bestehender `scripts/migrate-*`).

## 2. Ziel-Schema (DDL-Skizze)

Enums als `text` + `CHECK` (flexibler als PG-ENUM bei den evolvierenden deutschen Status-Werten). Alle Zeitfelder `timestamptz`. Tenant-Isolation weiter über `tenant_id`-Filter im Repository (optional später RLS).

```sql
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;      -- case-insensitive email

create table tenants (
  id            text primary key,           -- = slug (z.B. 'mbc'); Legacy nicht migriert
  name          text not null,
  display_name  text,
  slug          text unique not null,
  status        text not null default 'active' check (status in ('active','suspended','trialing','past_due','canceled')),
  email_from_name  text,
  email_reply_to   text,
  -- Billing (für PR 3b vorbereitet):
  plan                  text,
  stripe_customer_id    text unique,
  stripe_subscription_id text,
  subscription_status   text,
  trial_ends_at         timestamptz,
  current_period_end    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table apps (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  name          text not null,
  description   text default '',
  slug          text not null,
  ticket_prefix text,
  labels        text[] not null default '{}',
  next_ticket_number int not null default 1,   -- ersetzt collection 'counters'
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, slug)
);

create table releases (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  app_id        text not null references apps(id) on delete cascade,
  version       text,
  title         text not null,
  description   text default '',
  status        text not null default 'geplant' check (status in ('geplant','in Arbeit','veröffentlicht')),
  release_date  timestamptz,
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table suggestions (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  app_id        text not null references apps(id) on delete cascade,
  type          text not null check (type in ('feature','bug','ticket')),
  title         text not null,
  description   text default '',
  status        text not null default 'neu',
  priority      text check (priority in ('niedrig','mittel','hoch','kritisch')),
  labels        text[] not null default '{}',
  tag           text,
  tag_updated_at timestamptz,
  votes         int not null default 0,        -- denormalisierter Zähler
  approved      bool not null default false,
  approved_at   timestamptz,
  release_id    text references releases(id) on delete set null,
  ticket_number text,
  user_fingerprint text,
  notification_enabled bool not null default false,
  notification_email   text,
  -- Bug-Felder:
  severity      text check (severity in ('low','medium','high','critical')),
  steps_to_reproduce text,
  expected_behavior  text,
  actual_behavior    text,
  environment   jsonb,                          -- {appVersion, platform, browser}
  created_at    timestamptz not null default now()
);
create index on suggestions (app_id, approved);
create index on suggestions (tenant_id);
create index on suggestions (release_id);

create table votes (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  suggestion_id text not null references suggestions(id) on delete cascade,
  user_fingerprint text not null,
  -- DSGVO: rohe IP NICHT mehr speichern (Audit-Empfehlung). Statt ip:
  --   entweder ganz weglassen oder gehasht + mit Retention.
  created_at    timestamptz not null default now(),
  unique (suggestion_id, user_fingerprint)      -- 1 Vote/Fingerprint DB-seitig erzwungen
);

create table comments (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  suggestion_id text not null references suggestions(id) on delete cascade,
  text          text not null,
  author_type   text not null check (author_type in ('admin','user')),
  author_fingerprint text,
  approval_status text not null default 'pending' check (approval_status in ('pending','approved','rejected')),
  approved_at   timestamptz, approved_by text,
  rejected_at   timestamptz, rejected_by text,
  created_at    timestamptz not null default now()
);
create index on comments (suggestion_id, approval_status);

create table attachments (                       -- ersetzt base64 screenshots[]
  id            uuid primary key default gen_random_uuid(),
  tenant_id     text not null references tenants(id) on delete cascade,
  parent_type   text not null check (parent_type in ('suggestion','comment')),
  parent_id     text not null,
  storage_key   text not null,                   -- Pfad im Object-Storage
  content_type  text,
  size_bytes    int,
  created_at    timestamptz not null default now()
);
create index on attachments (parent_type, parent_id);

create table activity (
  id            bigint generated always as identity primary key,
  tenant_id     text not null,
  ticket_id     text not null,                   -- → suggestions.id (soft ref; Cascade via App-Delete)
  action        text not null,
  old_value     text, new_value text, detail text,
  actor         text,
  created_at    timestamptz not null default now()
);
create index on activity (ticket_id, created_at);

create table users (
  id            text primary key,
  email         citext unique not null,
  display_name  text,
  status        text not null default 'active' check (status in ('active','disabled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table memberships (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  role          text not null check (role in ('owner','admin','viewer')),
  status        text not null default 'active' check (status in ('active','disabled')),
  disabled_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index on memberships (user_id, status);

create table invites (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  email         citext not null,
  role          text not null check (role in ('owner','admin','viewer')),
  status        text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  token_hash    text not null,
  expires_at    timestamptz, accepted_at timestamptz, revoked_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index on invites (tenant_id, status);
create index on invites (token_hash);

create table sessions (
  id            text primary key,
  user_id       text not null references users(id) on delete cascade,
  status        text not null default 'active',
  token_hash    text unique not null,
  last_used_at  timestamptz, expires_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table login_links (
  id            text primary key,
  email         citext not null,
  status        text not null default 'pending',
  token_hash    text unique not null,
  redirect_url  text,
  expires_at    timestamptz, consumed_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table api_keys (
  id            text primary key,
  tenant_id     text not null references tenants(id) on delete cascade,
  name          text not null,
  scopes        text[] not null default '{}',
  token_hash    text unique not null,
  token_prefix  text,
  created_by    text,
  last_used_at  timestamptz, revoked_at timestamptz,
  created_at    timestamptz not null default now()
);
```

`userSettings` (nur Legacy) wird **nicht** migriert (bleibt in Firestore mit Legacy).

## 3. Wichtige Design-Punkte

- **counters → `apps.next_ticket_number`.** Ticketnummer: `UPDATE apps SET next_ticket_number = next_ticket_number + 1 WHERE id=$1 RETURNING next_ticket_number - 1` (atomar, ersetzt die Firestore-Transaktion + eigene Collection).
- **votes.unique(suggestion_id, user_fingerprint)** erzwingt „1 Vote/Fingerprint" jetzt DB-seitig (heute nur App-Code). Vote = Transaktion: `INSERT ... ON CONFLICT DO NOTHING` + bei Insert `UPDATE suggestions SET votes = votes + 1`.
- **Kein `ORDER BY` im Alt-Code** → jede Liste bekommt in SQL explizites `ORDER BY` (created_at desc etc.). Sortierung nicht mehr in-memory.
- **Full-Collection-Scans verschwinden:** Admin-Stats/-Listen werden `WHERE tenant_id=… `+ Joins/`GROUP BY`.
- **Tenant-Isolation:** jede Repository-Query nimmt `tenant_id` als Pflicht-Parameter (kein Query ohne Scope). Optional Phase 6: Postgres RLS als Defense-in-Depth.
- **DSGVO-Chance:** `votes.ip` wird nicht mehr roh gespeichert (Audit-Punkt gleich miterledigt).
- **Timestamps:** Firestore-Timestamp → `timestamptz` via `toDate()`-Normalisierung im Migrations-Skript.

## 4. Migrations-Phasen (je eigener PR)

- **PR A – Fundament:** Neon-Projekt, `migrations/0001_init.sql` (Schema oben), `db/pool.js` (neon-serverless), Repository-Skeleton + Tests. Noch nicht in index.js verdrahtet.
- **PR B – Repositories:** Datenzugriff je Entität in `db/*.js` gegen Postgres, mit Integrationstests (gegen Neon-Branch-DB). API unverändert.
- **PR C – Umverdrahtung:** index.js-Routen entitätsweise von Firestore auf Repositories umstellen, Tests grün halten. Firestore-Aufrufe entfernen.
- **PR D – Object-Storage:** Screenshots → R2/Blob, `attachments`-Tabelle, Upload/Serve-Pfad; base64-Feld raus.
- **PR E – Datenmigration + Cutover:** Skript liest Nicht-Legacy-Tenants aus Firestore → Neon (+ Screenshots hochladen). Wartungsfenster, Deploy roadlight→Neon, Verifikation. Firestore als Rollback.
- **PR 3b – Stripe:** setzt auf den bereits vorhandenen Billing-Spalten auf.

## 5. Cutover & Rollback

Kleines Wartungsfenster (roadlight kurz read-only / Hinweis), Migrations-Skript idempotent (`ON CONFLICT`), nach Deploy Smoke-Tests (Board laden, Vote, Kommentar, Login, Tenant-Provisioning). Rollback = roadlight-Deploy auf vorherigen Commit (Firestore-Daten unangetastet, weil nur gelesen).

## 6. Offene Entscheidungen (für den User)

1. **Object-Storage:** Cloudflare R2 (billigster, S3-kompatibel) vs. Vercel Blob (einfachste Integration) vs. Supabase Storage.
2. **votes.ip:** ganz weglassen (empfohlen) oder gehasht + Retention?
3. **Query-Layer bestätigen:** raw `pg`/neon-serverless + Repos (empfohlen, dep-arm) — oder doch Drizzle (Schema-as-Code, mehr Komfort, mehr Dep)?
4. **Reihenfolge:** Migration *vor* Stripe (empfohlen, Billing dann direkt in Postgres) — bestätigt?
