# Interne Tickets: privater Workspace und MCP, Bauplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Interne Aufgaben liegen in einem privaten Roadlight-Workspace, den Claude aus jeder Session per MCP pflegt.

**Architecture:** Ein neuer Workspace-Status `private`. Öffentliche Wege verlangen weiter `active`; nur angemeldete Wege nutzen neue „Member“-Nachschlagefunktionen, die zusätzlich `private` zulassen. Der vorhandene MCP-Server bekommt weitere Werkzeuge und ein Startskript, das den Schlüssel aus dem Schlüsselbund liest.

**Tech Stack:** Node 22, Express, Postgres (Neon) und Firestore-Attrappe in Tests, `node --test`, MCP SDK.

**Spec:** [2026-11-26-interne-tickets-design.md](2026-11-26-interne-tickets-design.md)

## Global Constraints

- Gebaut wird erst, wenn das Härtungs-Paket (`786f64c`) in `main` und live ist. Dann `claude/privater-workspace` auf `origin/main` rebasen. Zeilennummern hier gelten für `786f64c`; im Zweifel nach Funktionsnamen suchen.
- Nur im Worktree `.claude/worktrees/privater-workspace` arbeiten. Dort liegt keine `.env` und keine `.env.local`; vor jedem Testlauf `ls .env .env.local` prüfen (erwartet: beide fehlen). Die Dateien im Hauptordner zeigen auf echte Dienste.
- Alt-Bereich (`/api/apps…`, `/api/suggestions…`, `api/legacy-public-filter.js`) bleibt unverändert.
- Keine neuen Dateien unter `api/` (Function-Limit bei Vercel).
- Öffentliches Repo: keine Schlüssel, keine E-Mail-Adressen, keine echten Ticketinhalte.
- Push, Merge nach `main` (deployt roadlight.pro) und jeder Prod-Schritt nur mit Bens OK.
- Deutsche Texte mit Umlauten.
- Vor dem Merge genau ein frischer Opus-Review (Auth und Migration).

## Review Focus

1. Einstellungen eines privaten Workspaces speichern: Status bleibt `private` (Task 1).
2. Gesperrter Workspace (`suspended`): weder öffentlich noch für Konsole oder API erreichbar (Task 1).
3. Anlage-Skript zweimal oder mit unbekannter E-Mail: klare Meldung, nichts halb geschrieben (Task 2).
4. Ein Board antwortet beim Auflisten mit Fehler: Er steht in der Antwort, die Liste sieht nie vollständig aus, wenn sie es nicht ist (Task 3).
5. Schlüssel fehlt im Schlüsselbund: verständliche Meldung statt stummem Verbindungsabbruch (Task 4).

---

### Task 1: Status `private`

**Files:**
- Create: `migrations/0010_private_tenant_status.sql`, `tests/private-workspace-routes.js`, `tests/private-workspace.test.js`, `tests/integration/private-workspace-postgres.test.js`
- Modify: `api/tenant-utils.js`, `db/tenants.js`, `api/index.js`, `tests/fake-app.js` (`db.batch()` mit `set`, `create`, `update`, `delete`, `commit`; die Einstellungs-Route braucht es)

**Interfaces:**
- Produces: `PRIVATE_TENANT_STATUS = 'private'`, `MEMBER_TENANT_STATUSES = ['active', 'private']` (`api/tenant-utils.js`); `repos.tenants.findMemberBySlug(slug)`; in `api/index.js`: `isMemberTenant(data) -> boolean`, `findMemberTenantBySlug(slug) -> tenant|null`, `findMemberTenantById(id) -> tenant|null`, `loadAdminSuggestion(req, suggestionId) -> {tenant, suggestionData, suggestionDoc} | {errorStatus, error}` (nutzt `req.adminTenant`).

- [ ] **Step 1: Routenlisten anlegen** (`tests/private-workspace-routes.js`)

  Exportiert `MARKER = 'GEHEIM-MARKER'` sowie:
  - `TENANT_ROUTES`: alle 12 öffentlichen Routen unter `/api/tenants/:tenantSlug` mit gültigen Parametern und gültigem Body (Board `board`, Eintrag `s1`, Anhang als UUID; `attachments` mit `postgresOnly: true`).
  - `OTHER_PUBLIC_ROUTES`: jede weitere Route ohne `requireAdminAuth`, `requireTenantAccess`, `requireApiKey`, je mit einem Satz Begründung (Alt-Bereich filtert auf `legacy`; Anmeldung; Einladung; Stripe-Signatur; HTML-Hülle; `notification-settings` liest nur Firestore).
  - `readUnauthenticatedRoutes()`: liest `api/index.js` und liefert `"METHOD pfad"` für jede `app.get|post|put|patch|delete`-Zeile ohne eine der drei Middlewares.

- [ ] **Step 2: Failing tests schreiben** (`tests/private-workspace.test.js`, Muster `tests/invite-owner-role.test.js`)

  Seed: Workspace `intern` (`private`, Name mit `MARKER`), `acme` (`active`), `aus` (`suspended`); ein Konto mit Owner-Mitgliedschaft in allen dreien; je ein API-Key mit allen Scopes (`buildApiKeyData`); Board, freigegebener Eintrag, Kommentar, Release, Einladung, Titel jeweils mit `MARKER`.

  | Testname | Erwartung |
  |---|---|
  | `jede Route ohne Anmeldung ist eingeordnet` | `readUnauthenticatedRoutes()` ist genau die Vereinigung beider Listen |
  | `öffentliche Tenant-Routen: privat wie unbekannt` | je Route `404`, `error === 'Tenant not found'` |
  | `Gegenprobe: aktiver Workspace kommt an der Prüfung vorbei` | je Route `error !== 'Tenant not found'` |
  | `übrige öffentliche Routen verraten nichts Privates` | Antworttext ohne `MARKER`; keine neuen Datensätze |
  | `Sitzung listet den privaten Workspace` | `GET /api/auth/session` enthält `intern`, nicht `aus` |
  | `Konsole erreicht den privaten Workspace` | `GET …/intern/apps`, `…/suggestions`, `…/suggestions/s1/comments` je `200`; `POST …/s1/approve` `200` |
  | `API-Schlüssel arbeitet im privaten Workspace` | `GET /api/v1/me` `200`; Ticket anlegen `201`; Status ändern `200` |
  | `Einladungen in private Workspaces werden abgelehnt` | `POST` und `resend` je `409`, keine Mail |
  | `alle Konsolen-Lesewege finden den Workspace` | jede `GET`-Route mit `requireTenantAccess` (aus dem Quelltext gelesen): `error !== 'Tenant not found'` |
  | `API-Schlüssel anlegen` | `POST …/intern/api-keys` `201` |
  | `Einstellungen speichern lässt den Status` | nach `PUT …/settings` Status `private` |
  | `gesperrt bleibt gesperrt` | öffentlich `404`, Konsole `404`, API-Key `403` |

- [ ] **Step 3: Rot prüfen**

  Run: `node --test tests/private-workspace.test.js`
  Expected: Die Konsole-, API- und Sitzungs-Tests FAIL; die öffentlichen Tests sind schon grün (das ist der Sinn des Status).

- [ ] **Step 4: Implementieren**
  - `db/tenants.js`: `findMemberBySlug` wie `findActiveBySlug`, Bedingung `status in ('active', 'private')`. `findActiveBySlug` bleibt wörtlich.
  - `api/index.js`: die drei Nachschlagefunktionen für beide Datenwege (Firestore-Zweig von `findActiveTenantBySlug` samt Doppel-Slug-Fehler wiederverwenden, Prädikat als Parameter).
  - Umstellen auf Member: `resolveAdminTenantFromParam`, `requireApiKey`, beide Zweige in `loadActiveUserTenants`.
  - `loadAdminSuggestion` statt `resolveTenantSuggestionById` in allen angemeldeten Aufrufern (Zeilen 4913, 4967, 5027, 5503, 5529, 5585 und `updateTenantCommentModeration`).
  - Einladung anlegen und erneut senden: bei `private` `409` mit `{ error: 'Private Workspaces haben keine Einladungen.' }`.
  - Unverändert streng: alle Routen unter `/api/tenants/` und `resolvePendingInviteByToken`.

- [ ] **Step 5: Grün und Gegenprobe**

  Run: `npm test` → alle PASS.
  Run: `grep -n "resolveTenantSuggestionById(" api/index.js` → Definition plus genau 4 Aufrufe (Stimme setzen, entfernen, abfragen, Kommentar anlegen).

  **Beweis, dass der Schutz-Test anschlägt:** Für einen Lauf `findActiveTenantBySlug` im Firestore-Zweig auf die Member-Prüfung umbiegen: `privat wie unbekannt` muss bei jeder Route FAIL sein, die den Workspace nachschlägt. Zurücknehmen. Dasselbe im Postgres-Lauf aus Step 6 mit `findActiveBySlug` (`status in ('active','private')`). `git diff` zeigt danach keine Reste.

- [ ] **Step 6: Postgres-Test und Migration**

  Test zuerst: gleiche Routenlisten gegen echtes Postgres (Muster `api-v1-postgres.test.js`), inklusive `attachments`, Sitzung, API-Key, Konsole mit Admin-Passwort, `GET /api/user/notification-settings` ohne `MARKER` (nur Stolperdraht: die Route liest Firestore, der Test kann heute nicht rot werden). Zusätzlich mit `BILLING_ENFORCED=true` und `STRIPE_SECRET_KEY=sk_test_dummy` (vor dem Start der App setzen, kein Netzaufruf): im privaten Workspace mit Plan `pro` liefert `GET /api/v1/me` `200` und das Anlegen eines API-Schlüssels `201`. Migration:

  ```sql
  alter table tenants drop constraint if exists tenants_status_check;
  alter table tenants add constraint tenants_status_check
    check (status in ('active','suspended','trialing','past_due','canceled','private'));
  ```

  Wegwerf-Datenbank (beide URL-Variablen setzen, sonst kann der Migrationslauf eine andere Datenbank treffen):

  ```bash
  ~/.claude/bin/heavy-gate -- docker run --rm -d --name vt-privat-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:18-alpine
  ```

  Reihenfolge, alles in derselben Shell:

  ```bash
  export DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres DATABASE_URL_UNPOOLED=postgres://postgres:test@127.0.0.1:55432/postgres PGSSLMODE=disable ALLOW_DB_TESTS=1
  npm run db:migrate         # noch ohne die Datei 0010
  npm run test:integration   # Expected: neuer Test FAIL an der Prüfregel
  # jetzt migrations/0010_private_tenant_status.sql anlegen
  npm run db:migrate && npm run test:integration   # Expected: PASS
  ```

  Die Datenbank bleibt für Task 2 stehen und wird danach mit `docker stop vt-privat-pg` beendet. Ausgabe des grünen Laufs in die PR-Beschreibung.

- [ ] **Step 7: Commit** `feat: privater Workspace-Status`

### Task 2: Anlage-Skript

**Files:**
- Create: `lib/private-workspace.js`, `scripts/create-private-workspace.js`, `tests/private-workspace-script.test.js`
- Modify: `db/provisioning.js`, `tests/integration/private-workspace-postgres.test.js`, `package.json` (`workspace:create-private`)

**Interfaces:**
- Consumes: `PRIVATE_TENANT_STATUS`; `buildAppSlug` (`api/tenant-utils`); `WorkspaceExistsError`.
- Produces: `parseBoards(text) -> [{name, slug, ticketPrefix}]`; `repos.provisioning.provisionPrivateWorkspace({tenantId, slug, name, ownerEmail, boards, membershipId})`, wirft `OwnerNotFoundError` oder `WorkspaceExistsError`.

- [ ] **Step 1: Failing tests**
  - `parseBoards('FamilyManager:FM,Websites:WEB')` → zwei Boards mit Slugs `familymanager`, `websites`, Präfixen `FM`, `WEB`.
  - `parseBoards` wirft bei leerem Text, fehlendem Präfix, doppeltem Slug oder doppeltem Präfix.
  - Ohne `--commit`: keine Schreibabfrage; Ausgabe nennt Ziel-Host, Slug und Boards, nie Zugangsdaten.
  - Postgres: Anlage ergibt Status `private`, Plan `pro`, Boards, Mitgliedschaft `owner`; zweiter Lauf wirft `WorkspaceExistsError`; unbekannte E-Mail wirft `OwnerNotFoundError` und hinterlässt keine Zeile.
- [ ] **Step 2: Rot prüfen** `node --test tests/private-workspace-script.test.js` → FAIL (Modul fehlt)
- [ ] **Step 3: Implementieren.** Alles in einer Transaktion (`withTransaction`); das Konto wird nur gesucht, nie angelegt. Aufruf: `--slug intern --name Intern --email <adresse> --boards "<Name:Präfix,…>" [--commit]`; Env-Laden wie `scripts/migrate-db.js`.
- [ ] **Step 4: Grün** `npm test` und der Postgres-Lauf aus Task 1 → PASS
- [ ] **Step 5: Commit** `feat: Skript für privaten Workspace`

### Task 3: MCP-Werkzeuge

**Files:**
- Create: `mcp/actions.js`, `tests/mcp-actions.test.js` (lädt per `await import`)
- Modify: `mcp/server.js`

**Interfaces:**
- `api(method, path, body)` ist `apiRequest` aus `server.js`.
- Produces: `CLOSED_STATUSES`; `listOpen(api, {appSlug}) -> {items: [{id, ticketNumber, board, type, status, priority, title, labels}], errors: [{board, message}]}`; `createBoard`, `listReleases`, `createRelease`, `updateRelease`, `assignRelease`, jeweils `(api, input)`.

| Werkzeug | Aufruf | Eingabe |
|---|---|---|
| `voting_list_open` | `GET /apps`, dann je Board `GET /apps/:slug/suggestions` | `appSlug?` |
| `voting_create_board` | `POST /apps` `{boardName, boardSlug, ticketPrefix}` | `name`, `slug?`, `ticketPrefix?` |
| `voting_list_releases` | `GET /apps/:slug/releases` | `appSlug`, `status?` |
| `voting_create_release` | `POST /apps/:slug/releases` | `appSlug`, `version`, `title?`, `description?`, `status?`, `releaseDate?` |
| `voting_update_release` | `PATCH /releases/:id` | `releaseId` und die Felder oben |
| `voting_assign_release` | `PUT /suggestions/:id/release` `{releaseId}` | `suggestionId`, `releaseId` (oder `null`) |

- [ ] **Step 1: Failing tests** mit Attrappe für `api`:
  - `CLOSED_STATUSES` entspricht `RESOLVED_STATUSES` aus dem Quelltext von `api/index.js`.
  - `listOpen` lässt `ist umgesetzt`, `wird nicht umgesetzt`, `gelöst`, `geschlossen` weg und sortiert `kritisch`, `hoch`, `mittel`, `niedrig`, dann Ticketnummer.
  - Liefert ein Board einen Fehler, stehen die anderen in `items` und dieses in `errors`.
  - Je Schreibfunktion: Methode, Pfad (kodiert) und Body wie in der Tabelle; `assignRelease` sendet `releaseId: null` zum Lösen.
- [ ] **Step 2: Rot** `node --test tests/mcp-actions.test.js` → FAIL
- [ ] **Step 3: Implementieren**; `mcp/actions.js` ohne Abhängigkeiten, Werkzeuge in `server.js` mit `zod` registrieren, Status-Auswahl der Releases `geplant|in Arbeit|veröffentlicht`.
- [ ] **Step 4: Grün** `npm test`; `cd mcp && npm install && node --check server.js`
- [ ] **Step 5: Commit** `feat: MCP-Werkzeuge für Offenes, Boards und Releases`

### Task 4: Startskript und Anleitung

**Files:**
- Create: `mcp/start.sh` (ausführbar), `tests/mcp-start.test.js`
- Modify: `mcp/README.md`

**Interfaces:** `mcp/start.sh` liest den Dienst `roadlight-intern-api`, setzt `VOTING_TOOL_API_KEY` und führt `node <ordner>/server.js` aus.

- [ ] **Step 1: Failing tests** mit Attrappen für `security` und `node` im `PATH`: ohne Eintrag Exit `1`, Meldung nennt `roadlight-intern-api`, `node` läuft nicht; mit Eintrag bekommt `node` die Variable, der Wert steht weder in stdout noch stderr.
- [ ] **Step 2: Rot** `node --test tests/mcp-start.test.js` → FAIL
- [ ] **Step 3: Implementieren** (Bash, `exec`, kein `set -x`). README: Schlüssel in der Konsole erstellen (alle 8 Scopes), ablegen, registrieren. Registriert wird eine feste Kopie, weil der Hauptordner oft auf anderen Branches steht; nach Änderungen am Server die Kopie neu ziehen.

  ```bash
  security add-generic-password -a "$USER" -s roadlight-intern-api -w
  # im ausgecheckten Stand von main:
  mkdir -p "$HOME/.claude/mcp/roadlight-intern"
  cp mcp/server.js mcp/actions.js mcp/start.sh mcp/package.json mcp/package-lock.json "$HOME/.claude/mcp/roadlight-intern/"
  npm ci --omit=dev --prefix "$HOME/.claude/mcp/roadlight-intern"
  claude mcp add --scope user roadlight-intern -- "$HOME/.claude/mcp/roadlight-intern/start.sh"
  ```

- [ ] **Step 4: Grün** `npm test` → PASS
- [ ] **Step 5: Commit** `feat: MCP-Start mit Schlüssel aus dem Schlüsselbund`

### Task 5: Runbook

**Files:** Create: `docs/private-workspace-runbook.md`

- [ ] **Step 1: Schreiben**, jeder Schritt mit „Bens OK“, Befehl, erwarteter Ausgabe:
  1. `npm run db:migrate:status` (offen: nur `0010`), dann `npm run db:migrate`.
  2. Merge nach `main`, Deployment abwarten.
  3. `npm run workspace:create-private -- --slug intern --name Intern --email <Konto> --boards "FamilyManager:FM,GymBo:GY,TheraBoard:TB,Roadlight:RL,Websites:WEB,Sonstiges:SO"`, Ausgabe prüfen, dann mit `--commit`.
  4. Messen: `https://roadlight.pro/api/tenants/intern` → `404`; `…/api/tenants/bkds` → `200`; `https://votingtool.benkohler.de/api/apps` → nur FamilyManager und GymBo.
  5. Ben meldet sich an, öffnet `/tenant-admin.html?tenant=intern` (Lesezeichen; nach der Anmeldung erscheint der erste Workspace nach Namen), erstellt den Schlüssel und legt ihn ab. Dann aus einem sauberen Worktree auf `origin/main` die feste Kopie anlegen und registrieren (Befehle in `mcp/README.md`); `voting_whoami` nennt `intern`.
  6. Vorschlagsliste für die Erstbefüllung an Ben (Fahrplan des Architektur-Checks, Übergabedateien, offene GitHub-Issues und PRs), dann anlegen. Danach dort die Stand-Spalte und offene Aufgaben durch einen Verweis auf Roadlight ersetzen.
  7. Regel für die globale `CLAUDE.md` an Ben zur Freigabe: „Aufgaben stehen in Roadlight (MCP `roadlight-intern`). Zu Beginn `voting_list_open` fürs Projekt-Board; neue Aufgaben als Ticket anlegen; Status bei Start `in Bearbeitung`, nach Merge `im Test`, live `gelöst`. Entscheidungen bleiben in der Übergabedatei.“
  - Rückweg: Code zurücknehmen; Migration bleibt.
- [ ] **Step 2: Commit** `docs: Runbook privater Workspace`
