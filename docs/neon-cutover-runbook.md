# Neon-Cutover-Runbook (Firestore → Postgres)

Big-Bang-Umstellung der SaaS-/Tenant-Daten von Firestore auf Neon Postgres.
**Legacy** (`votingtool.benkohler.de`, tenantId `legacy`) bleibt auf Firestore und
wird nie migriert. Betrifft nur das **roadlight**-Vercel-Projekt (roadlight.pro /
app.roadlight.pro, Branch `main`).

Der gesamte Postgres-Pfad liegt hinter `DATA_BACKEND` (Default `firestore`). Der
Cutover ist ein einzelner Env-Flip — jederzeit zurückdrehbar.

## Voraussetzungen (einmalig)
- Schema auf Neon aktuell: `npm run db:migrate` (wendet `migrations/*.sql` an).
- `.env.local` bzw. Vercel-Env enthält `DATABASE_URL` (pooled),
  `DATABASE_URL_UNPOOLED` (direct, für den Migrations-Runner) und die
  Firebase-Credentials (zum Lesen der Quelle).

## Cutover-Schritte

1. **Trockenlauf** — zeigt, was migriert würde (schreibt nichts):
   ```
   npm run db:migrate-data:dry-run
   ```
   Prüfen: nur Nicht-Legacy-Tenants, plausible Zeilenzahlen.

2. **Migration** — schreibt nach Neon (idempotent, ein erneuter Lauf ist gefahrlos):
   ```
   npm run db:migrate-data
   ```
   Am Ende werden die Neon-Zeilenzahlen je Tabelle ausgegeben; gegen den
   Trockenlauf abgleichen.

3. **Flip** — im **roadlight**-Vercel-Projekt (Production) setzen:
   ```
   DATA_BACKEND = postgres
   ```
   Danach neu deployen (Env-Änderung greift erst mit dem nächsten Deployment).

4. **Verifizieren** — nach dem Deploy auf roadlight.pro:
   - Ein Tenant-Board öffnen (z. B. `roadlight.pro/mitko/feedback`) — Einträge da?
   - Neuen Testeintrag anlegen + voten — landet in Neon?
   - Admin-Konsole (Login/Team/Settings) funktioniert?

## Split-Brain vermeiden
Zwischen Migration (Schritt 2) und Flip (Schritt 3) in Firestore geschriebene
Daten sind in Neon noch nicht enthalten. Fenster klein halten: Migration direkt
vor dem Flip erneut laufen lassen (idempotent), dann sofort flippen. Bei sehr
wenig Traffic (frühe Tenants) ist das Fenster unkritisch.

## Rollback
`DATA_BACKEND` im roadlight-Projekt auf `firestore` zurücksetzen (bzw. Var
entfernen) und neu deployen. **Achtung:** nach Postgres-Betrieb dort getätigte
Schreibvorgänge liegen nur in Neon und fehlen nach dem Rollback in Firestore.
Deshalb früh entscheiden, ob der Cutover bleibt.

## Danach
- Optional: Test-Tenants (`staging-saas-smoke`) in Neon aufräumen.
- Später: Screenshots ggf. nach R2 auslagern (`attachments.storage_key`; Proxy-
  Contract bleibt). Firestore bleibt für Legacy dauerhaft bestehen.
