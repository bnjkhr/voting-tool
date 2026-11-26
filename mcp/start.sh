#!/bin/bash
# Startet den MCP-Server mit dem API-Schlüssel aus dem macOS-Schlüsselbund,
# damit der Schlüssel in keiner Datei steht. stdout gehört dem MCP-Protokoll,
# Meldungen gehen nach stderr. Kein `set -x`: Es würde den Schlüssel ausgeben.
set -eu

SERVICE="roadlight-intern-api"

if ! VOTING_TOOL_API_KEY="$(security find-generic-password -s "$SERVICE" -w 2>/dev/null)" \
  || [ -z "$VOTING_TOOL_API_KEY" ]; then
  echo "[voting-tool-mcp] Kein API-Schlüssel lesbar: Eintrag \"$SERVICE\" fehlt oder ist leer, oder der Schlüsselbund ist gesperrt." >&2
  echo "Ablegen: security add-generic-password -a \"\$USER\" -s $SERVICE -w" >&2
  exit 1
fi

export VOTING_TOOL_API_KEY
exec node "$(dirname "$0")/server.js"
