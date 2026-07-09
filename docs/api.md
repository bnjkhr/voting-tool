# Voting Tool — Public API v1

Tenant-scoped REST API für externe Tools (z.B. Claude Code, CLIs, Scripts), um Einträge auf Boards zu lesen, anzulegen und zu aktualisieren.

## Base URL

```
https://votingtool.benkohler.de/api/v1
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

Fehlt ein erforderlicher Scope, gibt der Endpoint `403` zurück.

## Rate Limits

Pro Schlüssel:

- Read-Endpoints (`GET`): 120 Requests/Minute
- Einträge/Kommentare anlegen (`POST`): 30 Requests/Minute
- Status ändern (`PATCH`): 60 Requests/Minute

Überschreitung → `429 Too Many Requests`.

## Fehler-Format

```json
{ "error": "human-readable message" }
```

## Endpoints

### `GET /me`

Sanity-Check für den Key. Gibt Tenant- und Scope-Info zurück.

```bash
curl -H "Authorization: Bearer vt_live_…" \
  https://votingtool.benkohler.de/api/v1/me
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
  https://votingtool.benkohler.de/api/v1/apps
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
  "https://votingtool.benkohler.de/api/v1/apps/customer-feedback/suggestions?type=bug&status=offen"
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

### `POST /suggestions/:id/comments`

Admin-Kommentar hinzufügen (auto-freigegeben). Benötigt `comments:write`.

```json
{
  "text": "Wir haben das in Sprint 42 eingeplant.",
  "screenshots": []
}
```

`screenshots` ist optional und akzeptiert Base64-Data-URLs (`data:image/png;base64,…`), max. 5 Bilder, je max. 300 KB, gesamt max. 800 KB.

## Konstanten

**Suggestion-Typen:** `feature`, `bug`, `ticket`

**Status (Feature):** `neu`, `wird geprüft`, `wird umgesetzt`, `im Test`, `ist umgesetzt`, `wird nicht umgesetzt`

**Status (Bug/Ticket):** `neu`, `offen`, `in Bearbeitung`, `im Test`, `wartend`, `gelöst`, `geschlossen`

**Prioritäten:** `niedrig`, `mittel`, `hoch`, `kritisch`

**Bug-Severities:** `low`, `medium`, `high`, `critical` (wird beim Erstellen automatisch in `priority` gemappt)

## Audit

Jeder Write-Call (POST/PATCH/DELETE) wird in der `activity`-Collection mit `actor: "api:<keyId>"` protokolliert. Im Tenant-Admin-UI sind die Aktionen in der Eintrags-Historie sichtbar.

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
  https://votingtool.benkohler.de/api/v1/apps/customer-feedback/suggestions
```
