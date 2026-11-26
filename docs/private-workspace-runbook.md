# Runbook: privater Workspace für interne Tickets

Bringt den privaten Workspace `intern` nach Prod und bindet ihn per MCP an. Hintergrund: [Design](plans/2026-11-26-interne-tickets-design.md).

**Jeder Schritt braucht Bens ausdrückliches OK für genau diesen Schritt**, auch das reine Lesen aus Prod. Passt eine Ausgabe nicht zur erwarteten, wird angehalten.

## Vorher

- Der PR ist geprüft, alle Läufe am HEAD sind grün.
- Ein sauberer Checkout mit `npm ci`. Für Schritt 1 steht er auf dem PR-Stand (auf `main` fehlt die Migration vor dem Merge noch), ab Schritt 3 auf `origin/main`.
- Zugang zu Prod: eine Env-Datei mit `DATABASE_URL` und `DATABASE_URL_UNPOOLED`. Sie wird nicht in den Checkout kopiert, sondern mit `node --env-file=<Prod-Env-Datei>` übergeben. Die Shell darf keine eigene `DATABASE_URL` gesetzt haben, sonst gewinnt diese:

  ```bash
  unset DATABASE_URL DATABASE_URL_UNPOOLED
  ```

  Gleichwertig sind die npm-Skripte (`db:migrate:status`, `db:migrate`, `workspace:create-private`), wenn im Ausführungsordner eine `.env.local` mit den Prod-Werten liegt.

## Risiko

- Migration `0010` ersetzt nur die Prüfregel für `tenants.status`. Sie sperrt die Tabelle `tenants` kurz, prüft die wenigen vorhandenen Zeilen und läuft in einer Transaktion: Entweder gilt danach die neue Regel oder weiter die alte. Die neue Regel erlaubt alle bisherigen Werte.
- **Der Workspace `intern` darf nie auf `active` gesetzt werden**, das macht ihn öffentlich. Wird er gesperrt (`suspended`), muss er danach zurück auf `private`.

## 1. Migration (Bens OK)

```bash
node --env-file=<Prod-Env-Datei> scripts/migrate-db.js --status
```

Erwartet, und nur diese eine Migration offen:

```text
Angewandt: 9 | Offen: 1
  offen: 0010_private_tenant_status.sql
```

```bash
node --env-file=<Prod-Env-Datei> scripts/migrate-db.js
```

Erwartet:

```text
anwenden: 0010_private_tenant_status.sql ... ok
Fertig: 1 Migration(en) angewandt.
```

## 2. Merge nach `main` (Bens OK)

Der Merge deployt roadlight.pro. Das Deployment abwarten, bis es in Vercel für den Merge-Commit „Ready“ ist.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://roadlight.pro/api/tenants/bkds
```

Erwartet: `200`.

## 3. Workspace anlegen (Bens OK)

Vorher prüfen, dass unter dem Slug kein öffentlicher Workspace läuft:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://roadlight.pro/api/tenants/intern
```

Erwartet: `404`.

Probelauf. `<Konto>` ist die Adresse eines bestehenden, aktiven Roadlight-Kontos; sie gehört nicht ins Repository.

```bash
node --env-file=<Prod-Env-Datei> scripts/create-private-workspace.js --slug intern --name Intern --email <Konto> --boards "FamilyManager:FM,GymBo:GY,TheraBoard:TB,Roadlight:RL,Websites:WEB,Sonstiges:SO"
```

Erwartet (Ziel-Datenbank und Konto von Hand prüfen):

```text
Ziel-Datenbank: <Prod-Host>/<Datenbank>
Workspace: Intern (Slug intern, Status private, Plan pro)
Owner: <Konto>
Boards:
  - FamilyManager (Slug familymanager, Präfix FM)
  - GymBo (Slug gymbo, Präfix GY)
  - TheraBoard (Slug theraboard, Präfix TB)
  - Roadlight (Slug roadlight, Präfix RL)
  - Websites (Slug websites, Präfix WEB)
  - Sonstiges (Slug sonstiges, Präfix SO)
Probelauf: nichts geschrieben. Mit --commit ausführen.
```

Der Probelauf fragt die Datenbank nicht ab. Ob das Konto existiert und der Slug frei ist, prüft erst der echte Lauf, in einer Transaktion:

```bash
node --env-file=<Prod-Env-Datei> scripts/create-private-workspace.js --slug intern --name Intern --email <Konto> --boards "FamilyManager:FM,GymBo:GY,TheraBoard:TB,Roadlight:RL,Websites:WEB,Sonstiges:SO" --commit
```

Erwartet als letzte Zeile: `Workspace "intern" angelegt, 6 Boards.`

Bei `Kein aktives Konto …` oder `… existiert bereits` wurde nichts geändert.

## 4. Ohne Anmeldung messen (Bens OK)

```bash
for p in intern intern/apps intern/apps/familymanager intern/apps/familymanager/suggestions intern/apps/familymanager/releases; do printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "https://roadlight.pro/api/tenants/$p"; done
```

Erwartet: jede Zeile endet auf `404`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://roadlight.pro/api/tenants/bkds
```

Erwartet: `200`.

```bash
curl -s https://votingtool.benkohler.de/api/apps
```

Erwartet: nur FamilyManager und GymBo.

Antwortet eine Zeile für `intern` mit `200`: sofort anhalten. Mit Bens OK den Status in der Prod-Datenbank auf `suspended` setzen, Ursache klären, danach zurück auf `private`.

## 5. Schlüssel und MCP (Bens OK)

1. Ben meldet sich an und öffnet `https://app.roadlight.pro/tenant-admin.html?tenant=intern` (als Lesezeichen sichern: nach der Anmeldung erscheint der erste Workspace nach Namen).
2. Ben erstellt dort den API-Schlüssel mit allen 8 Scopes und legt ihn selbst im Schlüsselbund ab. Der Schlüssel erscheint in keinem Chat und in keiner Datei.
3. Aus einem sauberen Worktree auf `origin/main` die feste Kopie anlegen und registrieren: [mcp/README.md](../mcp/README.md), Abschnitt „Einrichten“.
4. In einer neuen Session `voting_whoami` aufrufen. Erwartet: Workspace-Slug `intern`.

## 6. Erstbefüllung (Bens OK)

1. Vorschlagsliste an Ben: Fahrplan des Architektur-Checks, Übergabedateien, offene GitHub-Issues und PRs.
2. Erst nach seinem OK anlegen. Aufgaben als Typ `ticket`, Fehler als Typ `bug`.
3. Danach in den Quellen die Stand-Spalte und die offenen Aufgaben durch einen Verweis auf Roadlight ersetzen.

## 7. Regel für die globale `CLAUDE.md` (Bens OK)

Wortlaut zur Freigabe, erst danach eintragen:

> „Aufgaben stehen in Roadlight (MCP `roadlight-intern`). Zu Beginn `voting_list_open` fürs Projekt-Board; neue Aufgaben als Ticket anlegen; Status bei Start `in Bearbeitung`, nach Merge `im Test`, live `gelöst`. Entscheidungen bleiben in der Übergabedatei.“

## Rückweg

- Code zurücknehmen (Revert auf `main` oder Rollback in Vercel). Der alte Stand behandelt den privaten Workspace als nicht aktiv und liefert ihn nicht aus.
- Die Migration bleibt; die erweiterte Prüfregel schadet nicht.
- Bei zurückgenommenem Code sind Konsole und Schlüssel für `intern` ohnehin ohne Zugriff. Soll nur der MCP-Zugang weg: Schlüssel in der Konsole widerrufen und `claude mcp remove --scope user roadlight-intern`.
