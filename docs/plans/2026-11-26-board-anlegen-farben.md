# Im Board anlegen und farbige Tags

Stand 26.11.2026, Tickets RL-012 und RL-013. Entwurfsbild freigegeben, gebaut wird genau das. Keine Migration, keine neue Datei unter `api/`.

## RL-012: Tickets in der Spalte anlegen

### Server

`POST /api/admin/tenants/:tenantSlug/suggestions` in `api/index.js`, `requireTenantAccess(['owner', 'admin'])`.

- Nur Workspaces mit Status `private`, sonst 403 „Anlegen gibt es nur in privaten Workspaces.“ In öffentlichen Workspaces wäre der Eintrag sofort öffentlich.
- Eingaben: `appId` (Board dieses Workspaces, sonst 404), `title` (Pflicht, höchstens 100 Zeichen), `description` (freiwillig, höchstens 1000), `priority` (`VALID_PRIORITIES`, Standard `mittel`), `status` (`offen`, `in Bearbeitung`, `im Test`, `wartend`; Standard `offen`). Ungültiges gibt 400, nie stilles Ersetzen.
- Eintrag: `type: 'ticket'`, `approved: true`, `labels: []`, keine Benachrichtigung, Ticketnummer wie sonst, Legacy-`tag` passend zum Status, Aktivität `created`. `userFingerprint: 'api:console'`: Das Präfix `api:` kennzeichnet intern angelegte Einträge ohne Mailadresse (`needsConfirm` in `board-model.js`).
- Es geht keine Mail raus, auch nicht an Admins.
- Antwort 201 mit `id` und `ticketNumber`.
- Eigener Zähler fürs Anfrage-Limit (30 je Minute): `rateLimit` zählt heute alle begrenzten Routen je IP gemeinsam, schnelles Anlegen darf „Feedback holen“ nicht sperren. Verhalten bestehender Routen bleibt.

### Konsole

- Sichtbar nur, wenn der Workspace `private` ist (aus `/settings`) und `canManageWorkspace()`.
- „+ Ticket“ direkt unter der Spaltenüberschrift in „Offen“, „In Arbeit“, „Im Test“, „Wartet“, nicht in „Fertig“. Gestrichelter Rahmen, mindestens 44 px.
- Ein Klick öffnet an dieser Stelle die Anlege-Karte (höchstens eine): Titel (mehrzeilig umbrechend, einzeilig gemeint), Board-Auswahl, Prioritäts-Auswahl, Textlink „Beschreibung hinzufügen“, gefüllter Knopf „Ticket anlegen“, Textlink „Abbrechen“.
- Auswahlen als Menü wie „Verschieben nach“ (`details` mit Knöpfen), kein natives `select`.
- Board: der Board-Filter, sonst das zuletzt benutzte (`localStorage`, je Workspace), sonst das erste. Priorität: `mittel`.
- Enter im Titel legt an (nicht während einer IME-Eingabe). In der Beschreibung ist Enter ein Umbruch, Cmd/Strg+Enter legt an. Esc oder „Abbrechen“ schließt und verwirft, der Fokus geht auf das „+ Ticket“ der Spalte.
- Nach dem Anlegen bleibt die Karte offen: Titel und Beschreibung leer, Priorität `mittel`, Board bleibt, Fokus im Titel. Meldung „<Nummer> angelegt.“; blendet der Label-Filter das Ticket aus: „<Nummer> angelegt. Der Label-Filter blendet es aus.“
- Knopf gesperrt bei leerem Titel und während des Speicherns; kein doppeltes Anlegen.
- Fehler: Text bleibt stehen, Meldung in der Karte.
- `renderBoard` ersetzt die Spalten (Feedback-Holen, Verschieben, Breitenwechsel): Eingaben, Fokus und Schreibmarke der Anlege-Karte müssen das überstehen.
- „+ Ticket“ in einer anderen Spalte verschiebt die offene Karte mit ihrem Inhalt dorthin. Auf schmalen Bildschirmen bleibt sie an ihrer Spalte.

## RL-013: farbige Tags (nur Board)

- `kritisch`: Grund und Rahmen `#BF2F2F`, Schrift weiß. `hoch`, Ticketnummer und Labels bleiben.
- Board-Tag: Schrift fett, ohne sichtbaren Rahmen, Farbe je Board. Reine Funktion in `board-model.js`: Boards nach `createdAt`, bei Gleichstand nach `slug`; Platz modulo 8.

| Platz | Grund | Schrift |
|---|---|---|
| 0 | `#E0F1E6` | `#1F6B3B` |
| 1 | `#EEE5FA` | `#5E35A8` |
| 2 | `#FAE3F0` | `#99246A` |
| 3 | `#EDF0D8` | `#55631A` |
| 4 | `#E2ECFA` | `#1D55A0` |
| 5 | `#DCF1F2` | `#0E6068` |
| 6 | `#F2E8DD` | `#7A4A1E` |
| 7 | `#E6E9EE` | `#3E4C63` |

Die Board-Auswahl der Anlege-Karte trägt dieselbe Farbe. Die Konsole hat keinen Dunkelmodus.

## Prüfen

- Tests zuerst rot: Route (Rollen, ohne Anmeldung, nicht privat, fremdes Board, jede ungültige Eingabe, leere Beschreibung, Status je Spalte, Nummer, Aktivität, keine Mail), Farbzuordnung, Konsole (Eingaben überstehen `renderBoard`, kein Doppel-Anlegen).
- Ein Integrationstest gegen echtes Postgres für das Anlegen.
- Browser bei 1280 und 375 px: mit Tastatur und Zeiger anlegen, lange Titel und Boardnamen, kein Querscrollen, Tippflächen mindestens 44 px, keine Seitenfehler, HTML in Boardnamen und Titeln bleibt Text.

## Nicht in diesem Schritt

Bearbeiten oder Löschen im Board, Labels vergeben, Bug/Feature anlegen, Anlegen in öffentlichen Workspaces, Farben in anderen Reitern.
