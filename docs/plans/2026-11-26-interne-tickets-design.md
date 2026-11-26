# Interne Tickets in Roadlight: privater Workspace und MCP

Stand 26.11.2026. Kurz-Design für Teil 1 und 2, wartet auf Freigabe.

## Wozu

Ben fehlt der Überblick, woran gerade gearbeitet wird und was offen ist. Alle internen Aufgaben liegen an einem Ort, und Claude legt sie aus jeder Session an und pflegt sie. Zuerst nur für den eigenen Gebrauch.

## Ziele

- Ein privater Workspace, ein Board je Projekt.
- Ohne Anmeldung ist daraus nichts abrufbar.
- Claude kann aus jeder Session: Offenes über alle Boards auflisten, Einträge anlegen, Status, Priorität und Labels ändern, kommentieren.
- Die Boards sind beim Start mit dem befüllt, was heute offen ist.

## Nicht in diesem Schritt

- Überblick- oder Kanban-Ansicht (Teil 3, vorher Entwurfsbild).
- Private Boards als Kundenfunktion, Schalter in der Oberfläche.
- Umzug des Feedbacks von FamilyManager und GymBo (Entscheidung 03.09.2026: bleibt auf dem alten Board).
- Änderungen am Alt-Bereich.
- Vorschlag, noch zu bestätigen: Titel und Beschreibung bleiben per API unveränderlich (Nachträge als Kommentar); die Grenze von 1.000 Zeichen bleibt.

Gescheitert wäre es, wenn ein interner Eintrag öffentlich lesbar wird oder wenn die Boards nach zwei Wochen nicht mehr dem Stand entsprechen.

## Bauwege

| Weg | Dafür | Dagegen |
|---|---|---|
| **Privater Workspace** (gewählt am 26.11.) | die vorhandene Aktiv-Prüfung sperrt die öffentlichen Zugänge | Kundenfeedback anderer Workspaces steht nicht in derselben Liste |
| Privates Board | alles in einem Workspace | rund 11 Prüfstellen, jede vergessene ist ein Leck |
| Privat je Eintrag | feinste Steuerung | jede Liste und jeder Zähler betroffen |

## Voraussetzung

Das laufende Härtungs-Paket ist live (Entscheidung 26.11.). Erst danach wird gebaut, auf dem dann aktuellen `main`.

## Teil 1: privater Workspace

**Mechanik: ein eigener Status `private` statt eines Zusatzschalters.** Die öffentlichen Routen verlangen heute `status = 'active'`. Sie bleiben unverändert streng; nur angemeldete Wege (Konsole, API-Schlüssel, Anmeldung) dürfen zusätzlich `private` sehen. Vergisst der Bau eine Stelle, funktioniert dort etwas nicht, aber nichts wird öffentlich.

Das schützt auch gegen alte Stände: In 73 Code-Ständen mit Postgres-Schalter verlangt jede der 12 Routen unter `/api/tenants/` einen aktiven Workspace (am 26.11. per Skript über die Git-Historie geprüft: Aufruf der Prüffunktion je Route und `status = 'active'` in `db/tenants.js`). Alte Deployments und ein Zurückrollen liefern den privaten Workspace über diese Routen deshalb nicht aus.

- Migration `0010`: Status-Prüfregel der Tabelle `tenants` um `private` erweitern.
- Angemeldete Wege umstellen, darunter die Nachschlagefunktionen für Konsole, API-Schlüssel und die Workspace-Liste nach der Anmeldung.
- Kein Weg im Code ändert den Status eines bestehenden Workspaces (Einstellungen und Billing geprüft). Wer ihn von Hand auf `active` setzt, macht ihn öffentlich; nach einem Sperren muss er zurück auf `private`.
- Neues Skript mit Probelauf: legt den Workspace (von Anfang an `private`, Plan `pro`), seine Boards und eine Owner-Mitgliedschaft für ein bestehendes Konto an. Die E-Mail ist ein Argument und steht nicht im Repo. Nötig, weil die Super-Admin-Anlage nur nach Firestore schreibt und die Registrierung einen zweiten Workspace je E-Mail ablehnt.
- Ein Konto mit zwei Workspaces ist im Datenmodell vorgesehen. Nach der Anmeldung öffnet sich der erste nach Namen; gewechselt wird über `?tenant=` in der Adresse (Lesezeichen).
- Boards zum Start (Vorschlag): FamilyManager, GymBo, TheraBoard, Roadlight, Websites, Sonstiges.

### Tests

- Ein Test sammelt alle Routen ohne Anmelde-Prüfung (`requireAdminAuth`, `requireTenantAccess`, `requireApiKey`). Jede liefert für einen privaten Workspace 404 oder steht mit Begründung auf einer Ausnahmeliste. So fallen auch neue Routen außerhalb von `/api/tenants/` auf.
- Konsole und API funktionieren für den privaten Workspace; öffentliche Workspaces verhalten sich wie vorher.
- `/api/user/notification-settings` liefert nichts aus privaten Workspaces.
- Beide Datenwege: Firestore-Attrappe in `npm test` und Postgres. Die Postgres-Tests überspringen sich ohne `DATABASE_URL`; vor dem Merge laufen sie gegen eine lokale oder Wegwerf-Datenbank (nie Prod), der Lauf steht als Beleg im PR.

## Teil 2: MCP-Zugang

- `mcp/server.js` bekommt zusätzlich: Offenes über alle Boards, Board anlegen, Releases auflisten, anlegen, ändern und zuordnen. Die API-Routen dafür gibt es.
- Aufgaben sind Einträge vom Typ `ticket`, Fehler vom Typ `bug`.
- Den API-Schlüssel erstellt Ben in der Konsole. Er liegt im macOS-Schlüsselbund; ein kleines Startskript liest ihn. Kein Schlüssel in Dateien.
- Registrierung im User-Scope, damit jedes Projekt Tickets anlegen kann. Der Zugang reicht nur in den privaten Workspace.
- Eine Regel in der globalen `CLAUDE.md` (Wortlaut vorher zur Freigabe): neue Aufgaben als Ticket anlegen, Status bei Start, Merge und Live setzen. Entscheidungen bleiben in den Übergabedateien, Aufgaben stehen in Roadlight.
- Aufgabenstände werden danach nur noch in Roadlight gepflegt: Sie ersetzen die Stand-Spalte im Fahrplan und die offenen Aufgaben in den Übergabedateien.
- Erstbefüllung aus dem Fahrplan des Architektur-Checks vom 25.11., den Übergabedateien und offenen GitHub-Issues und PRs. Erst die Vorschlagsliste an Ben, dann anlegen.
- Kundenfeedback aus anderen Workspaces liest der Zugang zunächst nicht.

## Weg nach Prod

Jeder Schritt nur mit Bens OK.

1. Migration `0010` auf der Prod-Datenbank, vor dem Code, mit Runbook.
2. Deploy über `main`.
3. Anlage-Skript: Probelauf, dann echt.
4. Ohne Anmeldung messen: privat überall 404, öffentliche Boards und Alt-Bereich unverändert.
5. Schlüssel erstellen, MCP registrieren, befüllen.

**Rückweg:** Code zurücknehmen. Der alte Stand behandelt den privaten Workspace als nicht aktiv; die erweiterte Prüfregel darf bleiben.

## Freiheit beim Bau

Namen der MCP-Werkzeuge, Aufbau der Tests, Argumente des Skripts. Neue Hilfsdateien gehören nach `lib/` oder `db/`, nicht nach `api/` (Function-Limit bei Vercel).
