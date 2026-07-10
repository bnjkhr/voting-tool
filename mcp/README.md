# voting-tool MCP Server

Ein MCP-Server (Model Context Protocol), der Claude Code (und andere MCP-Clients) erlaubt, Einträge im Voting-Tool zu lesen, zu erstellen und zu aktualisieren — über die [Public API v1](../docs/api.md).

> **Pro-Feature:** API- und MCP-Zugriff sind Teil des Pro-Plans. Free-Workspaces können keine API-Schlüssel erstellen; bestehende Schlüssel liefern nach einem Downgrade `402`, bis wieder auf Pro upgradet wird.

## Setup

```bash
cd mcp
npm install
```

API-Schlüssel im Tenant-Admin-UI erstellen (`/tenant-admin.html?tenant=<dein-slug>` → Sidebar → „API-Schlüssel"). Für sinnvollen Funktionsumfang mindestens diese Scopes:

- `suggestions:read`
- `suggestions:write`
- `suggestions:status`
- `comments:read`
- `comments:write`

## Bei Claude Code registrieren

`~/.claude.json` (oder via `claude mcp add`) ergänzen:

```json
{
  "mcpServers": {
    "voting-tool": {
      "command": "node",
      "args": ["/Users/benkohler/Projekte/voting-tool/mcp/server.js"],
      "env": {
        "VOTING_TOOL_API_KEY": "vt_live_…",
        "VOTING_TOOL_API_BASE": "https://votingtool.benkohler.de/api/v1"
      }
    }
  }
}
```

Für lokale Entwicklung gegen den Dev-Server:

```json
"VOTING_TOOL_API_BASE": "http://localhost:3000/api/v1"
```

`VOTING_TOOL_API_BASE` ist optional; ohne sie wird auf die Produktions-URL gefallen.

## Verfügbare Tools

| Tool | Zweck | Scopes |
|---|---|---|
| `voting_whoami` | Tenant- und Scope-Info zum aktuellen Key | — |
| `voting_list_apps` | Alle Boards im Workspace | `suggestions:read` |
| `voting_list_suggestions` | Einträge eines Boards (mit Filtern) | `suggestions:read` |
| `voting_create_suggestion` | Neuen Eintrag erstellen (auto-freigegeben) | `suggestions:write` |
| `voting_get_suggestion` | Einzelnen Eintrag laden | `suggestions:read` |
| `voting_update_suggestion` | Status, Priorität, Labels ändern | `suggestions:status` |
| `voting_list_comments` | Kommentare eines Eintrags | `comments:read` |
| `voting_add_comment` | Admin-Kommentar hinzufügen | `comments:write` |

## Beispielnutzung

Sobald der Server in Claude Code registriert ist:

> „Lege im Board 'customer-feedback' einen Bug-Eintrag an: Login schlägt mit 500 fehl, Severity high. Steps to reproduce: …"

Claude wählt dann `voting_create_suggestion` mit den passenden Parametern.

## Debugging

Server manuell starten und ein paar JSON-RPC-Requests durchschieben:

```bash
VOTING_TOOL_API_KEY=vt_live_… node mcp/server.js
```

Audit-Trail: jeder Write-Call landet in der `activity`-Collection mit `actor: "api:<keyId>"` und ist im Tenant-Admin-UI in der Eintrags-Historie sichtbar.
