# Verknüpfung mit öffentlichen Einträgen, Stufe 2: Status zurückschreiben, Bauplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ändert sich der Status eines verknüpften internen Tickets, zieht der öffentliche Eintrag nach, solange keine Mail ginge und es kein Rückschritt ist. Sonst wartet die Änderung auf der Karte, bis ein angemeldeter Owner klickt. Nur dieser Klick verschickt eine Mail.

**Architecture:** Zustand der wartenden Änderung und ein atomarer Anspruch („Claim“) in `feedback_links` (Migration `0012`). Reine Entscheidungen (Zielstatus, Rückschritt, Mail-Empfänger ja/nein, Mail-Text) in `lib/feedback-push.js` und `api/email-templates.js`. Datenbank in `db/feedback.js`. Lesen und Schreiben der Quelle (Firestore für den Altbestand, Postgres für Workspaces), Ablauf und Routen in `api/index.js`. Die Garantie „höchstens einmal“ liefert allein der Postgres-Claim, nicht Firestore.

**Tech Stack:** wie Stufe 1 (Node 22, Express, Postgres/Neon, `tests/fake-app.js`, `node --test`, MCP SDK).

**Spec:** [2026-11-26-verknuepfung-oeffentlich-design.md](2026-11-26-verknuepfung-oeffentlich-design.md), Abschnitte „Stufe 2“, „Nur noch ein Schreibweg“, „Sichtbares“ (wartende Änderung, „Im Test“), „Gescheitert wäre es, wenn“. Dazu die Vorgaben des Auftraggebers (Schalter `push_enabled`, Mail nur per Owner-Klick, Absender des Altbestands).

## Global Constraints

- Nur im Worktree `.claude/worktrees/rueckschreiben`, Branch `claude/rueckschreiben` auf `origin/main`. Vor jedem Testlauf `ls .env .env.local` (beide fehlen). Wegwerf-Postgres wie in Stufe 1, Task 1 Step 1 (Container `vt-push-pg`, Port `55434`, über `~/.claude/bin/heavy-gate`).
- Keine neue Datei unter `api/`. Neuer Code in `lib/`, `db/`, `scripts/`, `public/`, `mcp/`, `api/index.js`, `api/email-templates.js`.
- Unverändert bleiben die Alt-Routen (`/api/apps…`, `/api/suggestions…`, `/api/admin/suggestions…`, `api/legacy-public-filter.js`), `sendUserNotificationEmail`, `notifySuggestionCreator`, `notifyTenantSuggestionCreator` und `legacy-stable`. Prüfung: `git diff origin/main -- api/index.js | grep '^-[^-]'` zeigt nur Zeilen im Feedback-Block (ab `FEEDBACK_FETCH_FAILED`) und die Antwortzeilen der beiden internen Statusrouten (Task 3).
- **Mail nur per Klick:** Die einzige Stelle, die `sendPushMail` aufruft, ist `confirmPush`. `confirmPush` ist nur über eine Konsolen-Route erreichbar, und die verlangt `req.tenantAuth.type === 'session'` und die Rolle `owner`. Admin-Passwort (`requireTenantAccess` setzt dafür `type: 'admin', role: 'owner'`), API-Schlüssel, MCP und Skripte erreichen sie nie.
- **Schalter `push_enabled`** je Quelle, Standard `false`, nur per Skript mit Probelauf. Ausgeschaltet entsteht weder ein Schreibzugriff noch eine wartende Änderung. Beim Ausschalten werden wartende Änderungen der Quelle in derselben Abfrage gelöscht. Nach dem Einschalten wird nichts nachgeholt; Holen und Verknüpfen von Hand schreiben öffentlich nie.
- **Nie** ein nicht freigegebener Eintrag: Vor jedem Schreiben wird der Eintrag frisch aus der Quelle gelesen. Geschrieben wird nur bei `approved === true`, passender App bzw. passendem Workspace, Altbestand mit `isLegacyTenantData` und aktivem Quell-Workspace (`findActiveTenantById`). `approved` wird nie gesetzt.
- **Interner Statuswechsel scheitert nie am öffentlichen Schreiben:** erst den internen Status speichern, dann `pushAfterStatusChange` mit Zeitgrenze 8 s (`maxDuration` 30 s), in `try/catch`. Die Antwort bleibt `200`, dazu `publicPush: {result, message?}`. Kein Hintergrundlauf nach der Antwort.
- In Postgres, Antworten und Logs landen weder Empfängeradresse noch Resend- oder Firestore-Fehlertext, nur feste Meldungen (Liste in Task 2). Gespeichert wird nur, ob eine Mail ginge (`pending_mail`).
- Datenbanktests nur gegen die Wegwerf-Postgres. Öffentliches Repo: keine Adressen, Absender, App-IDs oder echten Inhalte, auch nicht im Runbook.
- Deutsche Texte mit Umlauten, Du-Form; vor der Oberfläche `~/.claude/ux-regelwerk.md` lesen. Push, Merge, jeder Prod-Schritt nur mit Bens OK. Genau ein frischer Opus-Review vor dem Merge (Migration, Nebenläufigkeit, Mailversand, Schreiben in fremde Datenbank).

## Review Focus

1. Keine Mail ohne Owner-Klick in einer Sitzung, auf keinem Weg (Task 3, 4, 6).
2. Doppelklick und parallele Aufrufe: höchstens ein Schreibzugriff und eine Mail je wartender Änderung (Task 1, 3).
3. Nicht freigegebener, fremder oder gelöschter Eintrag wird nie beschrieben (Task 3).
4. Interner Status bleibt gespeichert, wenn die Quelle hängt oder scheitert (Task 4).
5. `push_enabled = false`: kein Schreiben, keine wartende Änderung, keine Bedienung (Task 1, 4, 5).
6. Mail des Altbestands: Aussehen wie `legacy-stable`, Link auf votingtool.benkohler.de, Absender nur aus `LEGACY_EMAIL_FROM` (Task 2, 3).

## Festlegungen (sichere Variante, Ben kann ändern)

1. **Zielstatus** (`targetFor(internalStatus, publicType)`): `in Bearbeitung` und `wird umgesetzt` (von Hand verknüpfte Feature-Tickets) → Ticket/Bug `in Bearbeitung`, Feature `wird umgesetzt`. `gelöst` und `ist umgesetzt` → Ticket/Bug `gelöst`, Feature `ist umgesetzt`. `im Test` → nur über die Aktion „Im Test veröffentlichen“ (Konsole oder MCP), Ziel `im Test`. Alle übrigen Werte aus `TICKET_STATUSES ∪ FEATURE_STATUSES` (`neu`, `offen`, `wartend`, `geschlossen`, `wird geprüft`, `wird nicht umgesetzt`): keine Änderung, eine wartende Änderung wird verworfen. Die wartende Änderung spiegelt also immer den aktuellen internen Stand.
2. **Rückschritt** (`isBackward(current, target)`): Rang Ticket/Bug `neu`, `offen` = 0, `in Bearbeitung`, `wartend` = 1, `im Test` = 2, `gelöst`, `geschlossen` = 3; Feature `neu`, `wird geprüft` = 0, `wird umgesetzt` = 1, `im Test` = 2, `ist umgesetzt`, `wird nicht umgesetzt` = 3. Rückschritt heißt: Rang sinkt, oder der öffentliche Status ist schon erledigt (Rang 3) und ein anderer. Gleicher Status: nichts tun, wartende Änderung löschen. Unbekannter öffentlicher Status zählt als Rückschritt.
3. **Mail ginge**, frisch gelesen: Altbestand wie `notifySuggestionCreator` (Benachrichtigung am Eintrag mit gültiger Adresse, sonst bei `notificationEnabled` falsy `userSettings` zum Fingerabdruck mit `notificationsEnabled` und gültiger Adresse). Workspace: `notificationEnabled` und gültige `notificationEmail`. Ob `RESEND_API_KEY` gesetzt ist, spielt dafür keine Rolle.
4. **Reihenfolge beim Klick:** Claim → frisch lesen → öffentlich schreiben → `markMailing(token)` (nur wenn der Claim noch gilt; sonst keine Mail) → Mail → fertig. Der Klick sendet `{status, mail}`; findet das frische Lesen einen Empfänger, obwohl `pending_mail` falsch war, wird nichts geschrieben, `pending_mail` gesetzt und ein zweiter Klick auf „Übernehmen und Mail senden“ verlangt. Scheitert die Mail nach dem Schreiben, wird sie nicht wiederholt („Status veröffentlicht, die Mail ging nicht raus.“). Hängt ein Claim in `mailing`, wird er nie automatisch erneut genommen; die Karte zeigt „Ob die Mail rausging, ist unklar.“ und nur „Verwerfen“. Ein Claim in `writing`, älter als 2 Minuten, darf erneut genommen werden (Schreiben ist wiederholbar).
5. **Ohne Absender:** Fehlt `LEGACY_EMAIL_FROM` (oder `RESEND_API_KEY`), lehnt der Klick bei Altbestand-Einträgen mit Empfänger ab, bevor geschrieben wird: „Für Mails zum alten Board fehlt der Absender. Nichts veröffentlicht.“ (bzw. „Mailversand ist nicht eingerichtet. Nichts veröffentlicht.“). Ohne Empfänger wird auch ohne Absender geschrieben.
6. **Altbestand-Mail:** Markup, Betreff, Sie-Form, Farben und die Zeile „Typ“ wörtlich aus `git show origin/legacy-stable:api/index.js` (Zeilen 721–758), Status `tag_updated`, Kommentar `Neuer Status: {status}`. Zwei Abweichungen: Werte durch `htmlEscape`, Link fest `https://votingtool.benkohler.de/#suggestion-{entryId}`. Workspace-Mail: Text und Aussehen wie `sendUserNotificationEmail`, Absender `senderAddress()`, Link `tenantBoardEntryUrl`.
7. **Felder beim Schreiben** wie die jeweilige Statusroute: Altbestand `{status, tag: mapStatusToLegacyTag(type, status), tagUpdatedAt}` wie `PUT /api/admin/suggestions/:id/status` (Bug `im Test` ergibt dort wie hier Tag `in analyse`). Workspace `repos.suggestions.update` mit `status`, `tag`, `tagUpdatedAt`.
8. **Verlaufseintrag:** Altbestand direkt `db.collection('activity').add({tenantId: LEGACY_TENANT_ID, ticketId, action: 'status_changed', oldValue, newValue, detail: 'Status geändert: {alt} → {neu}', actor: 'admin', createdAt})`, denn `logActivity` schreibt unter Postgres nach Postgres. Workspace über `repos.activity.log` mit dem Quell-Workspace. Fester Akteur, nie die Mail der Person in der Konsole.
9. **Rechte:** Übernehmen und Verwerfen nur Owner mit Sitzung. „Öffentlich auf Im Test setzen“ dürfen Owner/Admin in der Konsole und Schlüssel mit `suggestions:status`. Ginge dabei eine Mail, entsteht nur eine wartende Änderung.
10. **`upsertSource`** setzt bei geänderter Quelle auch `push_enabled = false` und löscht wartende Änderungen.

---

### Task 1: Migration `0012` und Repository

**Files:** Create `migrations/0012_feedback_push.sql`, `tests/integration/feedback-push-db-postgres.test.js`; Modify `db/feedback.js`

```sql
alter table feedback_sources add column push_enabled bool not null default false;
alter table feedback_links
  add column pending_reason text check (pending_reason in ('mail','backward','failed','busy')),
  add column pending_mail bool not null default false,
  add column pending_error text,
  add column pending_at timestamptz,
  add column push_claim text,
  add column push_claimed_at timestamptz,
  add column push_stage text check (push_stage in ('writing','mailing')),
  add column pushed_status text, add column pushed_at timestamptz,
  add constraint feedback_links_pending_ck check ((pending_status is null) = (pending_reason is null)),
  add constraint feedback_links_claim_ck check ((push_claim is null) = (push_stage is null));
```

**Interfaces** (`db/feedback.js`, alle mit `tenantId` im `where`):
- `setPushEnabled(sourceId, enabled)`: beim Ausschalten im selben `update … from` alle `pending_*` der Quelle auf null (nur wo kein Claim in `mailing`).
- `setPending({tenantId, suggestionId, status, reason, mail, error}) -> link|null`: nur wenn die Quelle `push_enabled` ist und die Verknüpfung ein Ticket hat; `status: null` löscht. Fasst die Claim-Spalten nie an: Läuft gerade ein Claim, überschreibt es Status und Grund (`busy`), und `finishPush` lässt diesen neueren Stand stehen. Der automatische Weg schreibt vor dem Claim Grund `busy`.
- `claimPush({tenantId, suggestionId, expectStatus}) -> {token, link}|null`: ein `update … returning` mit `push_enabled`, `pending_status = expectStatus`, `t.status = 'private'` und „kein Claim, oder Claim in `writing` älter als 2 Minuten“ im `where`. `token = crypto.randomUUID()`.
- `markMailing(token) -> boolean` (`where push_claim = $token and push_stage = 'writing'`; nur bei `true` wird gemailt), `finishPush(token, {publicStatus, error})`: nur `where push_claim = $token`. Bei Erfolg `public_status`, `pushed_status`, `pushed_at`, `public_seen_at` setzen und `pending_*` löschen, sofern `pending_status` noch der geschriebene ist; sonst bleibt die neuere wartende Änderung (Grund `busy`).
- `releasePush(token, {reason, mail, error})`: Claim weg, wartende Änderung bleibt mit Grund.
- `discardPending({tenantId, suggestionId}) -> boolean`: auch bei hängendem `mailing`-Claim.
- `listLinks` liefert zusätzlich `pendingStatus`, `pendingReason`, `pendingMail`, `pendingError`, `pushStage`, `pushEnabled`.

- [ ] **Step 1: Failing tests** (Präfix `test_fbpush_`)

  | Testname | Erwartung |
  |---|---|
  | `Schalter aus: keine wartende Änderung` | `setPending` bei `push_enabled = false` liefert `null`, Zeile unverändert |
  | `Ausschalten löscht wartende Änderungen` | nach `setPushEnabled(false)` alle `pending_status` der Quelle null, andere Quelle unverändert |
  | `ein Claim gewinnt` | `Promise.all` aus 5× `claimPush`: genau ein Token |
  | `Claim nur für den erwarteten Status` | `expectStatus` veraltet: `null` |
  | `hängender Mailversand wird nie neu beansprucht` | Claim in `mailing`, `push_claimed_at` 1 h alt: `claimPush` `null`; in `writing` 3 min alt: Token |
  | `neuere Änderung bleibt stehen` | `setPending` während Claim setzt Status und `busy`, Claim unverändert; `finishPush` mit altem Status lässt `pending_status` des Neueren |
  | `abgelaufener Claim mailt nicht` | Token freigegeben oder neu vergeben: `markMailing(alterToken)` `false` |
  | `anderer Workspace` | `claimPush`, `setPending`, `discardPending` mit fremder `tenantId`: nichts |
  | `Quelle umgehängt` | `upsertSource` mit neuer Quelle setzt `push_enabled = false` und löscht wartende Änderungen |
- [ ] **Step 2: Rot** `npm run test:integration` (Spalten fehlen)
- [ ] **Step 3: Implementieren**, `npm run db:migrate && npm run test:integration` PASS
- [ ] **Step 4: Beweis:** in `claimPush` die Bedingung „kein Claim“ entfernen → `ein Claim gewinnt` FAIL mit 5 Token; zurück, PASS. Beide Ausgaben in die PR-Beschreibung.
- [ ] **Step 5: Commit** `feat: Schalter und wartende Änderungen fürs Zurückschreiben`

### Task 2: Reine Logik und Mail-Vorlagen

**Files:** Create `lib/feedback-push.js`, `tests/feedback-push.test.js`, `tests/fixtures/legacy-status-mail.html`; Modify `api/email-templates.js`, `tests/email-templates.test.js`

**Interfaces:**
- `targetFor(internalStatus, publicType) -> string|null`, `isBackward(current, target, publicType) -> boolean`, `TEST_STATUS = 'im Test'` (Festlegungen 1, 2).
- `decidePush({internalStatus, entry, mail, explicitTest}) -> {action: 'none'|'clear'|'write'|'wait', target, reason?}`: `wait` bei `mail` (`reason: 'mail'`) oder Rückschritt (`reason: 'backward'`).
- `legacyMailRecipient(entry, userSettings) -> boolean`, `workspaceMailRecipient(entry) -> boolean`: nur ja/nein (Festlegung 3).
- `PUSH_MESSAGES`: feste Texte, u. a. „Der öffentliche Eintrag ist nicht freigegeben.“, „Den öffentlichen Eintrag gibt es nicht mehr.“, „Die Quelle antwortet nicht.“, „Status veröffentlicht, die Mail ging nicht raus.“, „Ob die Mail rausging, ist unklar.“ und die beiden aus Festlegung 5.
- `api/email-templates.js`: `buildLegacyStatusMail({entryId, title, appName, entryType, status}) -> {subject, html}`, `buildTenantStatusMail({title, appName, entryType, status, entryUrl}) -> {subject, html}`, `legacySenderAddress() -> string|null` (`LEGACY_EMAIL_FROM` getrimmt, leer → `null`, nie `EMAIL_FROM`).

- [ ] **Step 1: Failing tests:** jede Zeile der Tabelle aus Festlegung 1 für Ticket, Bug und Feature; `targetFor('im Test', …)` ohne `explicitTest` `null`; Rückschritt für `gelöst` → `in Bearbeitung`, `geschlossen` → `gelöst`, `ist umgesetzt` → `wird umgesetzt`, unbekannt → `true`; kein Rückschritt `neu` → `in Bearbeitung`; `decidePush` mit Empfänger `wait`/`mail`, auch bei `explicitTest`; `buildLegacyStatusMail` gleich der Fixture (aus legacy-stable abgeleitet, mit Platzhalterwerten), Link `https://votingtool.benkohler.de/#suggestion-e1`, `<b>` im Titel maskiert; `buildTenantStatusMail` gleich dem, was `sendUserNotificationEmail` mit denselben Werten an die Attrappe schickt (`sentMails`); `legacySenderAddress()` ohne Variable `null`, auch wenn `EMAIL_FROM` gesetzt ist.
- [ ] **Step 2: Rot** `node --test tests/feedback-push.test.js tests/email-templates.test.js`
- [ ] **Step 3: Implementieren** (ohne Netz, ohne Datenbank), **Step 4: Grün**
- [ ] **Step 5: Commit** `feat: Zielstatus, Rückschritt und Mail-Vorlagen fürs Zurückschreiben`

### Task 3: Schreiben in die Quelle und Bestätigen

**Files:** Modify `api/index.js` (Feedback-Block, dazu nur die Anhänge an die beiden internen Statusrouten), `tests/fake-app.js` (`writeLog` je Sammlung und Dokument, `failWrites(name, {hang})`, `failMails(error)` für die Resend-Attrappe), `tests/integration/api-v1-postgres.test.js` (Kopfkommentar: zweite Ausnahme Zurückschreiben); Create `tests/integration/feedback-push-postgres.test.js`

**Interfaces (in `api/index.js`):**
- `readPushTarget(source, entryId) -> {entry, mail: boolean}`: Altbestand liest `suggestions/{id}` und bei Bedarf `userSettings`; Workspace `findActiveTenantById` und `repos.suggestions.findById`. Wirft `FeedbackSourceError` mit fester Meldung bei fremd, gelöscht, nicht freigegeben.
- `writePublicStatus(source, entry, status)`: Felder und Verlauf nach Festlegungen 7 und 8. Ist der Status schon gesetzt, wird nichts geschrieben.
- `sendPushMail(source, entry, status) -> void`: wirft bei fehlendem Schlüssel, fehlendem Absender oder Resend-`error`. Einziger Aufrufer `confirmPush`.
- `runPush(tenant, link, {mode: 'auto'|'confirm', target})`: Claim → `readPushTarget` → `decidePush` → schreiben oder `releasePush`. Die Zeitgrenze von 8 s gilt fürs Lesen und Schreiben.
- `confirmPush(req, tenant, suggestionId, {status, mail})`: prüft vor dem Claim Sitzung und Owner, dann `runPush` im Modus `confirm`; mit Empfänger erst Absender prüfen, dann schreiben, `markMailing`, `sendPushMail`.
- `pushAfterStatusChange(tenant, suggestionId, status) -> {result: 'none'|'written'|'waiting'|'error', message?}`: wirft nie, nur bei `feedbackEnabled(tenant)` und geändertem Status; Modus `auto`. Schon hier an `PUT /api/admin/tenants/:tenantSlug/suggestions/:suggestionId/status` und `PATCH /api/v1/suggestions/:suggestionId` angehängt (`publicPush` in der Antwort, übrige Felder gleich), damit die Tests dieser Task laufen.
- `loadFeedbackState` und `buildFeedbackLinkResponse` liefern zusätzlich `pendingStatus`, `pendingReason`, `pendingMail`, `pendingError`, `pushStage`, `pushEnabled` (Quelle).

| Route | Schutz | Antwort |
|---|---|---|
| `POST /api/admin/tenants/:tenantSlug/feedback/links/:suggestionId/publish` `{status}` | `requireTenantAccess(['owner'])` und `type === 'session'`, sonst `403`; `rateLimit(60000, 20)` | `{result: 'published'\|'published_no_mail'\|'busy'\|'error', message?, state}` |
| `POST …/feedback/links/:suggestionId/discard` | wie oben | `{success, state}` |
| `POST …/feedback/links/:suggestionId/test` | `requireTenantAccess(['owner','admin'])` | `{publicPush, state}` |
| `POST /api/v1/suggestions/:suggestionId/public-test` | `requireApiKey(['suggestions:status'])`, `rateLimitByApiKey(60000, 60)` | `{publicPush}` |

Alle neuen Routen in die Einordnung von `tests/private-workspace-routes.js` aufnehmen (geschützt), die Liste öffentlicher Wege bleibt.

- [ ] **Step 1: Failing tests** (fake-app mit Postgres, Präfix `test_fbpushapi_`; Altbestand-Quelle in der Attrappe, Workspace-Quelle `test_fbpushapi_acme`; Mails nur über `sentMails`)

  | Testname | Erwartung |
  |---|---|
  | `keine Mail ohne Klick` | intern `gelöst` per Konsole (Owner), per `PATCH /api/v1/suggestions/:id` und `…/public-test` bei Einträgen mit Benachrichtigung: `sentMails` leer **und** `pending_status = 'gelöst'`, `pending_mail = true`; Quelle unverändert (`writeLog` ohne `suggestions`) |
  | `Klick ohne Sitzung schickt nichts` | `…/publish` mit Admin-Passwort `403`, mit API-Schlüssel `401`, als Admin-Mitglied `403`: `sentMails` leer, Änderung wartet weiter |
  | `Owner-Klick schreibt und mailt einmal` | `Promise.all` aus 5× `…/publish`: genau ein `published`, `writeLog` einmal `suggestions/{id}` und einmal `activity`, `sentMails.length === 1`, Absender `LEGACY_EMAIL_FROM`, Link votingtool.benkohler.de |
  | `ohne Mail sofort` | Eintrag ohne Empfänger: intern `in Bearbeitung` schreibt öffentlich `in Bearbeitung` (Feature: `wird umgesetzt`), Verlaufseintrag, keine Mail, kein `pending` |
  | `nicht freigegeben bleibt unberührt` | Eintrag `approved: false` (auch nach dem Holen so geworden): kein Schreiben, Meldung „nicht freigegeben“ |
  | `fremder Eintrag` | Verknüpfung zeigt auf Eintrag anderer App, eines `isLegacyTenantData`-fremden Tenants oder eines `suspended` Workspaces: kein Schreiben |
  | `Rückschritt wartet` | öffentlich `gelöst`, intern `in Bearbeitung`: `pending_reason = 'backward'`, nichts geschrieben; Owner-Klick schreibt |
  | `ohne Absender keine Mail` | `LEGACY_EMAIL_FROM` fehlt: Klick bei Eintrag mit Empfänger `error` mit Meldung aus Festlegung 5, kein Schreiben; Workspace-Eintrag mailt mit `EMAIL_FROM` |
  | `Mail scheitert nach dem Schreiben` | Resend-Attrappe liefert `error`: Status geschrieben, `pending` leer, Meldung „ging nicht raus“; zweiter Klick schickt nichts |
  | `hängender Mailversand` | Claim in `mailing`: `…/publish` `busy`, `sentMails` leer; `…/discard` räumt auf |
  | `Schalter aus` | `push_enabled = false`: Statuswechsel, `…/test`, `…/public-test` und `…/publish` schreiben nicht, `pending` bleibt leer |
  | `kein Nachholen` | Statuswechsel bei Schalter aus, dann Schalter an und erneut holen: öffentlich unverändert |
  | `Im Test nur auf Wunsch` | intern `im Test` ändert öffentlich nichts; `…/test` schreibt `im Test` |
  | `interner Text bleibt intern` | internes Ticket mit eigenem Titel, Beschreibung, Kommentar: nach dem Schreiben unterscheidet sich das Quelldokument nur in `status`, `tag`, `tagUpdatedAt`; Verlauf und Mail enthalten weder internen Titel noch Beschreibung noch die Adresse der Person in der Konsole |
  | `Empfänger erst beim Klick entdeckt` | `pending_mail = false`, Eintrag hat inzwischen Benachrichtigung: Klick „Übernehmen“ schreibt nichts, `sentMails` leer, `pending_mail = true` |
  | `Workspace-Quelle` | dieselben Fälle für `test_fbpushapi_acme`: Zeile in `suggestions` und `activity` des Quell-Workspace, Roadlight-Mail nur nach Owner-Klick |
- [ ] **Step 2: Rot** `npm run test:integration`
- [ ] **Step 3: Implementieren**, **Step 4: Grün**
- [ ] **Step 5: Beweis „vor dem Fix rot“:** in `runPush` den Modus `auto` wie `confirm` behandeln → `keine Mail ohne Klick` FAIL (`sentMails.length` > 0); die Sitzungsprüfung in `confirmPush` entfernen → `Klick ohne Sitzung` FAIL. Zurück, PASS. Ausgaben in die PR-Beschreibung.
- [ ] **Step 6: Commit** `feat: Status in die öffentliche Quelle schreiben, Mail nur nach Owner-Klick`

### Task 4: Zeitgrenze und Fehler beim Nachziehen

**Files:** Modify `api/index.js` (nur Zeitgrenze und Fehlerfälle von `pushAfterStatusChange`), `tests/integration/feedback-push-postgres.test.js`, `tests/feedback-routes.test.js`

- [ ] **Step 1: Failing tests:** ein Klick, dessen Lesen die Zeitgrenze reißt und später doch weiterläuft, mailt nicht mehr, wenn inzwischen ein zweiter Klick gemailt hat (`sentMails.length === 1`); `failReads('suggestions', {hang: true})`: Antwort `200` in unter 10 s, interner Status gespeichert, `publicPush.result = 'error'`, `pending_reason = 'failed'`; `failWrites('suggestions')`: ebenso; zwei gleichzeitige Statuswechsel auf dasselbe Ticket: höchstens ein Schreiben in die Quelle, am Ende entspricht `pending_status` oder der öffentliche Status dem zuletzt gespeicherten internen; Ticket ohne Verknüpfung: Antwort wie bisher ohne Quellzugriff (`readLog` leer); unter Firestore (`feedback-routes.test.js`): Antworten der beiden Routen unverändert, neue Routen `409`.
- [ ] **Step 2: Rot**, **Step 3: Implementieren**, **Step 4: Grün** `npm test` und `npm run test:integration`; die `git diff`-Prüfung aus den Global Constraints.
- [ ] **Step 5: Commit** `feat: Nachziehen übersteht hängende und scheiternde Quellen`

### Task 5: Karte in der Konsole

**Files:** Modify `public/board-model.js`, `public/tenant-admin.js`, `public/tenant-admin.html`, `tests/board-model.test.js`, `tests/tenant-board.test.js`

**Interfaces:**
- `BoardModel.pendingLine(link, {isOwner}) -> {text, action: 'publish'|'publish_mail'|null, canDiscard, error}|null`: „Wartet auf Veröffentlichung: {status}“; Knopf „Übernehmen und Mail senden“ bei `pendingMail`, sonst „Übernehmen“; Textlink „Verwerfen“; Fehlerzeile aus `pendingError`; bei `pushStage = 'mailing'` nur „Ob die Mail rausging, ist unklar.“ und „Verwerfen“. Ohne `pushEnabled` `null`.
- `BoardModel.testAction(item, link) -> boolean`: Textlink „Öffentlich auf Im Test setzen“ bei internem `im Test`, `pushEnabled` und öffentlichem Status ungleich `im Test`.
- `tenant-admin.js`: `canPublishPublic()` = `currentMembership?.role === 'owner'` (wie der Server, der die Mitgliedschaft prüft; `currentRole` ist für Plattform-Admins `super_admin` und taugt dafür nicht), `publishCard(id)`, `discardCard(id)`, `setPublicTest(id)`; Knopf gesperrt, solange die Anfrage läuft.

- [ ] **Step 1: Failing tests:** jede Variante von `pendingLine`; Admin sieht Zeile ohne Knopf; `pushEnabled: false` zeigt keine Bedienung, auch bei vorhandener Änderung; Doppelklick sendet ein `POST …/publish` mit `{status}`; Fehlertext maskiert (`<img …>`); `testAction` nur bei den drei Bedingungen.
- [ ] **Step 2–4: Rot, Implementieren, Grün** `npm test`
- [ ] **Step 5: Im Browser prüfen** wie Stufe 1 Task 5: 1280 px und 375 px, kein seitliches Scrollen, genau ein gefüllter Knopf je Karte; Bildschirmfotos in die Rückmeldung.
- [ ] **Step 6: Commit** `feat: wartende Veröffentlichung auf der Karte`

### Task 6: Skript und MCP

**Files:** Modify `scripts/feedback-sources.js`, `tests/feedback-sources-script.test.js`, `mcp/actions.js`, `mcp/server.js`, `mcp/README.md`, `tests/mcp-actions.test.js`

**Interfaces:**
- Skript: `enable-push` / `disable-push --workspace <slug> --board <slug> [--commit]`; ohne `--commit` Probelauf mit Zielanzeige und Anzahl wartender Änderungen, die gelöscht würden; `list` zeigt `Zurückschreiben: an|aus`. Kein Befehl sendet Mails oder schreibt öffentlich.
- MCP: `setPublicTest(api, {suggestionId}) -> POST /suggestions/:id/public-test`, Werkzeug `voting_set_public_test`. Beschreibung: „Ginge eine Mail, wartet die Änderung auf Bens Klick in der Konsole.“ Kein Werkzeug zum Bestätigen.
- [ ] **Step 1: Failing tests:** Skript ohne `--commit` keine Schreibabfrage; `enable-push` auf nicht privatem Workspace Exit `1`; `disable-push --commit` löscht wartende Änderungen; MCP Methode, kodierter Pfad, kein Aufruf von `…/publish` in `mcp/` (`grep` im Test).
- [ ] **Step 2–4: Rot, Implementieren, Grün** `npm test`; `cd mcp && npm install && node --check server.js`
- [ ] **Step 5: Commit** `feat: Schalter fürs Zurückschreiben und MCP für Im Test`

### Task 7: Runbook

**Files:** Modify `docs/feedback-links-runbook.md` (neuer Abschnitt „Stufe 2“)

- [ ] **Step 1: Schreiben**, jeder Schritt mit „Bens OK“, Befehl und erwarteter Ausgabe, nur Platzhalter:
  1. `npm run db:migrate:status` (offen nur `0012`), `npm run db:migrate`.
  2. Ben setzt `LEGACY_EMAIL_FROM` in Vercel (Production) und prüft, dass der Resend-Zugang von roadlight.pro von dieser Domain senden darf. Fehlt das, bleibt es bei Veröffentlichen ohne Mail.
  3. Merge nach `main`, Deployment abwarten; `GET /api/v1/feedback`: alle Quellen mit Zurückschreiben aus.
  4. Feste MCP-Kopie neu ziehen wie in Stufe 1 Schritt 3; `voting_set_public_test` gelistet.
  5. **Schreibweg vereinheitlichen**, Texte vorher Ben zeigen: `~/.claude/CLAUDE.md` („Tickets in Roadlight“), `~/.claude/wissen/orchestrierung-und-boards.md` („Immer aktuell halten“, TheraBoard), `~/.claude/skills/projekt-aufraeumen/SKILL.md`, `TheraBoard/material/roadlight/roadlight-eintragen.py` (setzt keinen Status mehr an verknüpften Einträgen), FamilyManager-Memory `feedback_votingtool_immer_aktuell`. Morgenlauf, Kommentare, Release-Zuordnung bleiben.
  6. Testeintrag ohne Mailadresse auf einem Board des Altbestands anlegen, freigeben, verknüpfen; `enable-push` ohne, dann mit `--commit` nur für dieses Board.
  7. Intern `in Bearbeitung`: öffentlich nachgezogen, Verlaufseintrag da, keine Mail. Zeigt sich, dass das Schreiben in den Altbestand scheitert: `disable-push --commit`, anhalten, Ben fragen.
  8. Erst dann die übrigen Boards einschalten, je Board mit Bens OK.
  - Rückweg: `disable-push --commit` je Board (löscht wartende Änderungen); Code zurücknehmen; Spalten bleiben.
- [ ] **Step 2: Commit** `docs: Runbook Verknüpfung Stufe 2`
