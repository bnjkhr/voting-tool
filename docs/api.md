# Voting Tool — Public API v1

Tenant-scoped REST API für externe Tools (z.B. Claude Code, CLIs, Scripts), um Einträge auf Boards zu lesen, anzulegen und zu aktualisieren.

> **Pro-Feature:** API- und MCP-Zugriff sind Teil des Pro-Plans. Free-Workspaces können dann keine API-Schlüssel erstellen; bestehende Schlüssel liefern nach einem Downgrade `402 Payment Required` (`code: "upgrade_required"`), bis der Workspace wieder auf Pro upgradet.
>
> **Aktueller Stand:** Das Gating ist über den Master-Schalter `BILLING_ENFORCED` gesteuert und standardmäßig **aus**. Solange Premium nicht live geschaltet ist (`BILLING_ENFORCED` ≠ `true`), haben **alle** Workspaces vollen API-/MCP-Zugriff.

## Base URL

```
https://roadlight.pro/api/v1
```

Lokal:

```
http://localhost:3000/api/v1
```

## Authentifizierung

Jeder Request braucht einen API-Key im `Authorization`-Header:

```
Authorization: Bearer vt_live_<token>
```

API-Keys werden im Tenant-Admin-UI unter „API-Schlüssel" erstellt (`/tenant-admin.html?tenant=<slug>`). Der Klartext-Token wird nur einmal beim Erstellen angezeigt — danach speichert die Datenbank nur einen SHA-256-Hash.

Jeder Key ist auf genau einen Tenant gescoped — er sieht ausschließlich Boards und Einträge dieses Workspaces.

### Scopes

| Scope | Erlaubt |
|---|---|
| `suggestions:read` | Boards und Einträge lesen |
| `suggestions:write` | Einträge anlegen (auto-freigegeben) |
| `suggestions:status` | Status, Priorität und Labels ändern |
| `comments:read` | Kommentare lesen |
| `comments:write` | Admin-Kommentare schreiben (auto-freigegeben) |
| `boards:write` | Boards anlegen und umbenennen |
| `releases:read` | Releases lesen |
| `releases:write` | Releases anlegen, ändern, löschen und Einträge zuordnen |

Fehlt ein erforderlicher Scope, gibt der Endpoint `403` zurück. Bestehende
Schlüssel bekommen durch die neuen Scopes nichts dazu — sie müssen an einem
Schlüssel explizit gesetzt sein.

Für einen kompletten Workspace-Aufbau per API (Board anlegen, Einträge
importieren, Releases nachbauen und zuordnen) braucht der Schlüssel:
`boards:write`, `suggestions:read`, `suggestions:write`, `suggestions:status`,
`releases:read`, `releases:write`.

Den Workspace (Tenant) selbst legt weiterhin ein Mensch im UI an — dafür gibt es
bewusst keinen v1-Endpunkt.

## Rate Limits

Pro Schlüssel:

- Read-Endpoints (`GET`): 120 Requests/Minute
- Anlegen (`POST`): 30 Requests/Minute
- Ändern (`PATCH` / `PUT`): 60 Requests/Minute
- Löschen (`DELETE`): 30 Requests/Minute

Überschreitung → `429 Too Many Requests`.

## Fehler-Format

```json
{ "error": "human-readable message" }
```

## Endpoints: Einträge & Kommentare

### `GET /me`

Sanity-Check für den Key. Gibt Tenant- und Scope-Info zurück.

```bash
curl -H "Authorization: Bearer vt_live_…" \
  https://roadlight.pro/api/v1/me
```

Response:

```json
{
  "tenant": { "id": "tenant_abc", "slug": "acme", "name": "Acme Workspace" },
  "key": { "name": "Claude Code lokal", "scopes": ["suggestions:read", "suggestions:write"] }
}
```

### `GET /apps`

Liste der Boards im Tenant. Benötigt `suggestions:read`.

```bash
curl -H "Authorization: Bearer vt_live_…" \
  https://roadlight.pro/api/v1/apps
```

Response:

```json
[
  {
    "id": "app_xyz",
    "slug": "customer-feedback",
    "name": "Customer Feedback",
    "description": "Wünsche und Bugs unserer Kund:innen",
    "ticketPrefix": "CF"
  }
]
```

### `GET /apps/:appSlug/suggestions`

Liste aller Einträge in einem Board (auch nicht-freigegebene). Benötigt `suggestions:read`.

Query-Filter (optional):

- `type` — `feature`, `bug`, `ticket`
- `status` — beliebiger gültiger Status (siehe Konstanten unten)
- `approved` — `true` / `false`

```bash
curl -H "Authorization: Bearer vt_live_…" \
  "https://roadlight.pro/api/v1/apps/customer-feedback/suggestions?type=bug&status=offen"
```

### `POST /apps/:appSlug/suggestions`

Neuen Eintrag erstellen — **automatisch freigegeben**. Benötigt `suggestions:write`.

Body:

```json
{
  "type": "feature",
  "title": "Dark mode für die Mobile App",
  "description": "Auf dem iPhone fehlt aktuell der Dark-Mode-Schalter."
}
```

Bug-Variante:

```json
{
  "type": "bug",
  "title": "Login schlägt mit 500 fehl",
  "description": "Beim Login mit Google kommt 500.",
  "severity": "high",
  "stepsToReproduce": "1. /login öffnen\n2. Google-Button klicken",
  "expectedBehavior": "Erfolgreicher Login",
  "actualBehavior": "500 Internal Server Error",
  "environment": { "platform": "iOS 17.4", "browser": "Safari 17" }
}
```

Ticket-Variante:

```json
{
  "type": "ticket",
  "title": "Domain umziehen",
  "description": "DNS-Records auf Cloudflare migrieren",
  "priority": "hoch"
}
```

Response (`201`):

```json
{
  "id": "sug_abc123",
  "ticketNumber": "CF-042",
  "type": "feature",
  "title": "Dark mode für die Mobile App",
  "description": "…",
  "status": "neu",
  "priority": "mittel",
  "labels": [],
  "approved": true,
  "votes": 0,
  "appId": "app_xyz",
  "tenantId": "tenant_abc",
  "severity": null,
  "createdAt": "2026-05-21T14:12:33.000Z"
}
```

### Import bestehender Einträge

Beim Übertragen eines gewachsenen Boards vergibt der Server sonst Ticketnummer
und Datum selbst. Der optionale `import`-Block übernimmt stattdessen die Werte
aus der Quelle. Er ist an `suggestions:write` gebunden und greift **nur**, wenn
er explizit mitgeschickt wird — normale Einreichungen ändern sich nicht.

```json
{
  "type": "feature",
  "title": "Einkaufsliste teilen",
  "description": "…",
  "import": {
    "ticketNumber": "FAM-041",
    "votes": 2,
    "createdAt": "2026-04-30T09:12:00.000Z"
  }
}
```

| Feld | Verhalten |
|---|---|
| `ticketNumber` | Überschreibt den Generator. Muss zum Ticket-Prefix des Boards passen und im Board eindeutig sein (Kollision → `409`). Hebt den Board-Zähler an: nach einem Import von `FAM-140` bekommt der nächste regulär angelegte Eintrag `FAM-141`. |
| `votes` | Setzt den Stimmen-Zähler (ganze Zahl ≥ 0). Es werden **keine** `votes`-Dokumente erzeugt, damit die Doppelabstimmungs-Sperre sauber bleibt. |
| `createdAt` | Überschreibt den Serverzeitstempel. Nur Vergangenheit; ungültig oder in der Zukunft → `400`. |

Alle Felder sind einzeln optional, mindestens eines muss gesetzt sein.

**Nicht importierbar:** Notification-Adressen. Ein Import mit
`notificationEnabled: true` wird mit `400` abgelehnt — sonst schickt ein späterer
Statuswechsel Mails an Leute, die von dem neuen Board nichts wissen.

Import-Schreibvorgänge landen im Audit-Log mit `action: "imported"` und
`actor: "api:<keyId>"` und sind so von regulären Anlagen unterscheidbar.

### `GET /suggestions/:id`

Einzelnen Eintrag laden. Benötigt `suggestions:read`. 404, wenn Eintrag nicht zum Tenant des Keys gehört.

### `PATCH /suggestions/:id`

Status, Priorität und/oder Labels ändern. Benötigt `suggestions:status`.

Body (alle Felder optional, mindestens eines erforderlich):

```json
{
  "status": "wird umgesetzt",
  "priority": "hoch",
  "labels": ["mobile", "ux"]
}
```

Setzt automatisch `approved: true`, falls ein Status ≠ `neu` gesetzt wird.

### `GET /suggestions/:id/comments`

Liste aller Kommentare (auch pending). Benötigt `comments:read`.

> **Hinweis zu `screenshots`:** Angehängte Bilder kommen als URL statt als
> Base64-Data-URL zurück. Die URL zeigt auf `GET /attachments/:id` (siehe
> unten) und ist mit demselben API-Key abrufbar.

### `POST /suggestions/:id/comments`

Admin-Kommentar hinzufügen (auto-freigegeben). Benötigt `comments:write`.

```json
{
  "text": "Wir haben das in Sprint 42 eingeplant.",
  "screenshots": []
}
```

`screenshots` ist optional und akzeptiert Base64-Data-URLs (`data:image/png;base64,…`), max. 5 Bilder, je max. 300 KB, gesamt max. 800 KB.

Die Antwort gibt `screenshots` bereits in der Lese-Form zurück (URLs auf
`GET /attachments/:id`), nicht das gerade hochgeladene Base64.

### `GET /attachments/:attachmentId`

Liefert die Bytes eines angehängten Bildes. Benötigt `comments:read`,
240 Requests/Minute.

Die IDs stehen in `screenshots[]` der Kommentar-Endpunkte — URLs von dort
unverändert verwenden, nicht selbst zusammenbauen. Der Workspace kommt aus dem
API-Key: eine ID aus einem fremden Workspace liefert `404`, ebenso eine
unbekannte ID.

Antwort ist das Bild selbst (`image/png`, `image/jpeg`, `image/gif` oder
`image/webp`), kein JSON.

```bash
curl -H "Authorization: Bearer vt_live_…" \
  https://roadlight.pro/api/v1/attachments/0f8b1c9e-... --output screenshot.png
```

## Boards

### `POST /apps`

Board anlegen. Benötigt `boards:write`. Der Tenant kommt aus dem Schlüssel — es
gibt keinen Tenant-Parameter.

```json
{
  "name": "FamilyManager",
  "slug": "familymanager",
  "ticketPrefix": "FAM",
  "description": "Wünsche und Bugs aus der Familie"
}
```

- `slug` optional — wird sonst aus `name` abgeleitet.
- `ticketPrefix` optional — wird sonst aus `name` abgeleitet (max. 5 Buchstaben).
- Slug bereits im Workspace vergeben → `409`.
- Free-Plan: Es gilt dasselbe Board-Limit wie im UI. Über dem Limit →
  `402` mit `code: "upgrade_required"` und `resource: "boards"`.

Response (`201`):

```json
{
  "id": "app_xyz",
  "slug": "familymanager",
  "name": "FamilyManager",
  "description": "Wünsche und Bugs aus der Familie",
  "ticketPrefix": "FAM"
}
```

### `PATCH /apps/:appSlug`

Board umbenennen bzw. Beschreibung ändern. Benötigt `boards:write`.

```json
{ "name": "Family Manager", "description": "Neuer Text" }
```

`slug` und `ticketPrefix` sind **unveränderlich** — am Slug hängen bestehende
Key-Integrationen und öffentliche Board-URLs, am Prefix die bereits vergebenen
Ticketnummern. Werden sie mitgeschickt, antwortet der Endpoint mit `400`.

## Releases

### `GET /apps/:appSlug/releases`

Releases eines Boards inklusive der zugeordneten Einträge (`items[]`, nur
freigegebene). Benötigt `releases:read`.

Query-Filter (optional): `status` — kommagetrennt, aus `geplant`, `in Arbeit`,
`veröffentlicht`.

```bash
curl -H "Authorization: Bearer vt_live_…" \
  "https://roadlight.pro/api/v1/apps/familymanager/releases?status=geplant,in%20Arbeit"
```

Response:

```json
[
  {
    "id": "rel_abc",
    "appId": "app_xyz",
    "version": "2.3.0",
    "title": "Kalender-Sync",
    "description": "…",
    "status": "geplant",
    "releaseDate": "2026-10-01T00:00:00.000Z",
    "items": [
      { "id": "sug_1", "ticketNumber": "FAM-041", "title": "…", "type": "feature", "status": "wird umgesetzt" }
    ]
  }
]
```

### `POST /apps/:appSlug/releases`

Release anlegen. Benötigt `releases:write`. Das Board kommt aus dem Pfad — eine
`appId` im Body wird ignoriert.

```json
{
  "version": "2.3.0",
  "title": "Kalender-Sync",
  "description": "Was in diesem Release steckt",
  "status": "geplant",
  "releaseDate": "2026-10-01"
}
```

- `status` aus `geplant`, `in Arbeit`, `veröffentlicht`; Default `geplant`.
- `releaseDate` optional, beliebiges parsebares Datum; ungültig → `400`.
- Bei `veröffentlicht` wird `publishedAt` automatisch gesetzt.

### `PATCH /releases/:releaseId`

Teilfelder eines Releases ändern (`version`, `title`, `description`, `status`,
`releaseDate`). Benötigt `releases:write`. Ein Release aus einem fremden
Workspace ist `404`.

```json
{ "status": "veröffentlicht", "releaseDate": null }
```

`"releaseDate": null` **löscht** das Datum (nicht: ignoriert es). Response ist
das aktualisierte Release.

### `DELETE /releases/:releaseId`

Release löschen. Benötigt `releases:write`. Zugeordnete Einträge werden nur
entkoppelt, nicht gelöscht.

Response:

```json
{ "success": true, "message": "Release gelöscht", "unlinkedSuggestions": 12 }
```

### `PUT /suggestions/:id/release`

Eintrag einem Release zuordnen. Benötigt `releases:write`. `null` hebt die
Zuordnung auf.

```json
{ "releaseId": "rel_abc" }
```

## Konstanten

**Suggestion-Typen:** `feature`, `bug`, `ticket`

**Status (Feature):** `neu`, `wird geprüft`, `wird umgesetzt`, `im Test`, `ist umgesetzt`, `wird nicht umgesetzt`

**Status (Bug/Ticket):** `neu`, `offen`, `in Bearbeitung`, `im Test`, `wartend`, `gelöst`, `geschlossen`

**Prioritäten:** `niedrig`, `mittel`, `hoch`, `kritisch`

**Bug-Severities:** `low`, `medium`, `high`, `critical` (wird beim Erstellen automatisch in `priority` gemappt)

## Audit

Jeder eintragsbezogene Write-Call (POST/PATCH/PUT) wird in der `activity`-Collection mit `actor: "api:<keyId>"` protokolliert. Importe bekommen dabei `action: "imported"` statt `"created"`. Im Tenant-Admin-UI sind die Aktionen in der Eintrags-Historie sichtbar.

Board- und Release-Anlagen haben keine Ticket-ID und damit keinen Eintrag in der `activity`-Collection.

## Beispiel: Eintrag aus einem Bash-Script anlegen

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${VOTING_TOOL_API_KEY:?Bitte API-Key in VOTING_TOOL_API_KEY setzen}"

curl -fsS -X POST \
  -H "Authorization: Bearer $VOTING_TOOL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "bug",
    "title": "CI rot nach Merge",
    "description": "PR #42 hat E2E-Tests gerötet",
    "severity": "medium",
    "stepsToReproduce": "main pullen, npm test",
    "expectedBehavior": "alle Tests grün",
    "actualBehavior": "tenant-admin.spec.js schlägt fehl"
  }' \
  https://roadlight.pro/api/v1/apps/customer-feedback/suggestions
```
