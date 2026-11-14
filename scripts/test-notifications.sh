#!/bin/bash

# Test-Script für E-Mail-Benachrichtigungen
# Vorher: Stelle sicher, dass EMAIL_USER und EMAIL_PASSWORD in .env gesetzt sind

echo "🧪 Teste E-Mail-Benachrichtigungsfunktion..."

# Basis-URL (anpassen falls nötig)
BASE_URL="http://localhost:3000"

# Test 1: E-Mail-Einstellungen aktualisieren
echo "📧 Test 1: E-Mail-Einstellungen speichern"
curl -X PUT "${BASE_URL}/api/user/notification-settings" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@beispiel.de",
    "notificationsEnabled": true
  }' \
  -H "X-Forwarded-For: 192.168.1.100" \
  -H "User-Agent: TestBrowser"

echo -e "\n"

# Test 2: E-Mail-Einstellungen abrufen
echo "📋 Test 2: E-Mail-Einstellungen abrufen"
curl -X GET "${BASE_URL}/api/user/notification-settings" \
  -H "X-Forwarded-For: 192.168.1.100" \
  -H "User-Agent: TestBrowser"

echo -e "\n"

# Test 3: Neuen Vorschlag erstellen (benötigt gültige appId)
echo "💡 Test 3: Neuen Vorschlag erstellen"
# Zuerst eine App-ID abrufen
APP_ID=$(curl -s "${BASE_URL}/api/apps" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ ! -z "$APP_ID" ]; then
  echo "Verwende App-ID: $APP_ID"
  
  curl -X POST "${BASE_URL}/api/apps/${APP_ID}/suggestions" \
    -H "Content-Type: application/json" \
    -d '{
      "title": "Test-Vorschlag für Benachrichtigung",
      "description": "Dies ist ein Test-Vorschlag um die E-Mail-Benachrichtigung zu testen"
    }' \
    -H "X-Forwarded-For: 192.168.1.100" \
    -H "User-Agent: TestBrowser"
else
  echo "⚠️  Keine App-ID gefunden. Bitte erstelle zuerst eine App im Admin-Bereich."
fi

echo -e "\n"
echo "✅ Tests abgeschlossen!"
echo "📧 Überprüfe deine E-Mail auf Benachrichtigungen."