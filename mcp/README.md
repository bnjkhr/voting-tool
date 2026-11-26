# voting-tool MCP Server

Ein MCP-Server (Model Context Protocol), der Claude Code (und andere MCP-Clients) erlaubt, Einträge im Voting-Tool zu lesen, zu erstellen und zu aktualisieren — über die [Public API v1](../docs/api.md).

> **Pro-Feature:** API- und MCP-Zugriff sind Teil des Pro-Plans. Free-Workspaces können keine API-Schlüssel erstellen; bestehende Schlüssel liefern nach einem Downgrade `402`, bis wieder auf Pro upgradet wird.

## Einrichten (macOS)

Der Schlüssel liegt im macOS-Schlüsselbund. `start.sh` liest ihn beim Start und übergibt ihn dem Server; er steht in keiner Datei.

1. API-Schlüssel in der Konsole erstellen (`/tenant-admin.html?tenant=<dein-slug>` → Sidebar → „API-Schlüssel“) mit allen 8 Scopes: `suggestions:read`, `suggestions:write`, `suggestions:status`, `comments:read`, `comments:write`, `boards:write`, `releases:read`, `releases:write`.
2. Im Schlüsselbund ablegen. Der Befehl fragt den Schlüssel ab, er landet nicht in der Shell-History. Zum Ersetzen zusätzlich `-U` vor `-w` setzen.

   ```bash
   security add-generic-password -a "$USER" -s roadlight-intern-api -w
   ```

3. Eine feste Kopie anlegen und im User-Scope registrieren, damit jedes Projekt den Server nutzen kann. Registriert wird bewusst nicht der Ordner im Repository, weil der oft auf einem anderen Branch steht. Alle Befehle in einem ausgecheckten Stand von `main` ausführen:

   ```bash
   mkdir -p "$HOME/.claude/mcp/roadlight-intern"
   ```

   ```bash
   cp mcp/server.js mcp/actions.js mcp/start.sh mcp/package.json mcp/package-lock.json "$HOME/.claude/mcp/roadlight-intern/"
   ```

   ```bash
   npm ci --omit=dev --prefix "$HOME/.claude/mcp/roadlight-intern"
   ```

   ```bash
   claude mcp add --scope user roadlight-intern -- "$HOME/.claude/mcp/roadlight-intern/start.sh"
   ```

4. In einer neuen Session prüft `voting_whoami`, welchen Workspace der Schlüssel erreicht.

**Nach Änderungen am Server** die Kopie neu ziehen (`cp` und `npm ci` aus Schritt 3); die Registrierung bleibt.

### Lokale Entwicklung

```bash
cd mcp && npm ci
```

```bash
VOTING_TOOL_API_KEY=vt_live_… VOTING_TOOL_API_BASE=http://localhost:3000/api/v1 node mcp/server.js
```

`VOTING_TOOL_API_BASE` ist optional; ohne sie geht jede Anfrage an `https://roadlight.pro/api/v1`.

## Verfügbare Tools

| Tool | Zweck | Scopes |
|---|---|---|
| `voting_whoami` | Tenant- und Scope-Info zum aktuellen Key | — |
| `voting_list_apps` | Alle Boards im Workspace | `suggestions:read` |
| `voting_create_board` | Neues Board anlegen | `boards:write` |
| `voting_list_open` | Offene Einträge über alle Boards, nach Priorität | `suggestions:read` |
| `voting_list_suggestions` | Einträge eines Boards (mit Filtern) | `suggestions:read` |
| `voting_create_suggestion` | Neuen Eintrag erstellen (auto-freigegeben) | `suggestions:write` |
| `voting_get_suggestion` | Einzelnen Eintrag laden | `suggestions:read` |
| `voting_update_suggestion` | Status, Priorität, Labels ändern | `suggestions:status` |
| `voting_list_comments` | Kommentare eines Eintrags | `comments:read` |
| `voting_add_comment` | Admin-Kommentar hinzufügen | `comments:write` |
| `voting_list_releases` | Releases eines Boards | `releases:read` |
| `voting_create_release` | Release anlegen | `releases:write` |
| `voting_update_release` | Release ändern | `releases:write` |
| `voting_assign_release` | Eintrag einem Release zuordnen oder lösen | `releases:write` |

Erledigt und damit nicht in `voting_list_open`: `ist umgesetzt`, `wird nicht umgesetzt`, `gelöst`, `geschlossen`. Titel und Beschreibung eines Eintrags lassen sich nicht ändern; Nachträge kommen als Kommentar.

## Beispielnutzung

Sobald der Server in Claude Code registriert ist:

> „Lege im Board 'customer-feedback' einen Bug-Eintrag an: Login schlägt mit 500 fehl, Severity high. Steps to reproduce: …"

Claude wählt dann `voting_create_suggestion` mit den passenden Parametern.

## Debugging

Meldet Claude Code nur, dass sich der Server nicht verbinden ließ, zeigt der direkte Start den Grund (zum Beispiel ein fehlender Schlüsselbund-Eintrag). Beenden mit `Ctrl+C`.

```bash
"$HOME/.claude/mcp/roadlight-intern/start.sh"
```

Audit-Trail: jeder Write-Call landet in der `activity`-Collection mit `actor: "api:<keyId>"` und ist im Tenant-Admin-UI in der Eintrags-Historie sichtbar.
