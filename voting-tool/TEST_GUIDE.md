# Test-Checkliste für E-Mail-Benachrichtigungen

## ✅ Vorbereitung

### 1. Environment-Variablen setzen
Erstelle eine `.env` Datei im voting-tool Verzeichnis mit:

```env
# Firebase (bereits vorhanden)
FIREBASE_PROJECT_ID=dein-project-id
FIREBASE_CLIENT_EMAIL=dein-service-account
FIREBASE_PRIVATE_KEY=dein-private-key

# E-Mail (neu hinzugefügt)
EMAIL_USER=deine-email@gmail.com
EMAIL_PASSWORD=dein-app-passwort
BASE_URL=http://localhost:3000

# Admin (bereits vorhanden)
ADMIN_PASSWORD=dein-admin-passwort
```

### 2. Gmail App-Passwort erstellen
1. Gehe zu [Google Account Einstellungen](https://myaccount.google.com/)
2. Sicherheit → 2-Faktor-Authentifizierung aktivieren
3. [App-Passwörter generieren](https://myaccount.google.com/apppasswords)
4. Wähle "Andere" und gib einen Namen ein (z.B. "Voting Tool")
5. Kopiere das generierte Passwort in EMAIL_PASSWORD

## 🧪 Test-Schritte

### Phase 1: E-Mail-Einstellungen
1. Öffne `http://localhost:3000`
2. Klicke auf ⚙️ (Einstellungen) oben rechts
3. Gib deine E-Mail-Adresse ein
4. Aktiviere Benachrichtigungen
5. Speichern

**Erwartetes Ergebnis:** "Einstellungen gespeichert"

### Phase 2: Vorschlag erstellen
1. Wähle eine App aus
2. Erstelle einen neuen Vorschlag
3. Absenden

**Erwartetes Ergebnis:** 
- Erfolgsmeldung im Frontend
- Admin erhält E-Mail über neuen Vorschlag

### Phase 3: Admin-Aktionen
1. Wechsle zu `/admin.html`
2. Melde dich mit ADMIN_PASSWORD an
3. Finde deinen Test-Vorschlag
4. Führe Aktionen durch:
   - Genehmigen → Benutzer erhält "Genehmigt"-E-Mail
   - Kommentar hinzufügen → Benutzer erhält "Neuer Kommentar"-E-Mail
   - Ablehnen/Löschen → Benutzer erhält "Abgelehnt"-E-Mail

### Phase 4: Test mit Test-Seite
1. Öffne `http://localhost:3000/test.html`
2. Führe die automatisierten Tests durch
3. Überprübe das Debug-Log

## 🔍 Fehlerbehebung

### Problem: Keine E-Mails werden versendet
1. **Log prüfen:** Console im Browser + Server-Logs
2. **Environment:** Sind EMAIL_USER und EMAIL_PASSWORD gesetzt?
3. **Gmail:** Ist 2-Faktor-Authentifizierung aktiv?
4. **Firewall:** Blockiert dein System SMTP-Ports?

### Problem: E-Mail-Einstellungen werden nicht gespeichert
1. **Browser Console:** JavaScript-Fehler anzeigen
2. **Netzwerk-Tab:** API-Aufrufe prüfen
3. **E-Mail-Validierung:** Ist die E-Mail-Adresse gültig?

### Problem: Admin-Benachrichtigungen funktionieren nicht
1. **Admin-Passwort:** Korrekt in .env gesetzt?
2. **Authorization Header:** Wird im Request mitgesendet?
3. **Server-Logs:** Fehlermeldungen prüfen

## 📧 Test-E-Mail-Vorlagen

Die E-Mails enthalten:
- **Betreff:** "Dein Vorschlag \"[Titel]\" - [Status]"
- **Inhalt:** Status, Titel, App-Name, optional Kommentar
- **Design:** Moderne HTML-E-Mail mit Call-to-Action Button

## 🎯 Erfolgskriterien

✅ E-Mail-Einstellungen können gespeichert und geladen werden
✅ Benutzer erhält E-Mail bei Genehmigung seines Vorschlags
✅ Benutzer erhält E-Mail bei Ablehnung seines Vorschlags  
✅ Benutzer erhält E-Mail bei neuem Kommentar
✅ Admin erhält E-Mail bei neuem Vorschlag (bestehende Funktion)
✅ Alle E-Mails haben professionelles Design
✅ E-Mail-Adresse ist optional
✅ Benachrichtigungen können ein-/ausgeschaltet werden