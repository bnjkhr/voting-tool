# Kanban-Board in der Roadlight-Konsole

Stand 26.11.2026. Kurz-Design (Ticket RL-005), wartet auf Freigabe.

## Wozu

Auf einen Blick sehen, woran gearbeitet wird und was offen ist, und Einträge selbst weiterschieben. Zuerst für den privaten Workspace, als Funktion aber in jedem Workspace.

## Bauwege

| Weg | Dafür | Dagegen |
|---|---|---|
| **Reiter „Board“ in der Konsole** (gewählt) | ein Werkzeug, nutzt vorhandene Anmeldung und API, keine Migration | Konsole wächst |
| Eigene Board-App | frei gestaltbar | zweites Werkzeug samt Anmeldung |
| GitHub Projects | nichts zu bauen | Tickets lägen doppelt |

## Aussehen

```text
[ Einträge ] [ Board ] [ Releases ] [ Boards ] [ Einstellungen ]
Board: ( Alle v )   Label: ( alle v )
Offen 23      In Arbeit 6    Im Test 1     Wartet 16     Fertig 0
[Karte]       [Karte]        [Karte]       [Karte]       [Karte]
 kritisch WEB-001  Titel, Priorität nur bei kritisch/hoch, Nummer, Labels
```

Gezeigt und von Ben gesehen am 26.11. Entschieden: **eine** Spalte „Im Test“ (auch für TestFlight).

## Spalten

| Spalte | zeigt (Ticket und Bug) | zeigt (Feature) | Ablegen setzt Ticket/Bug | Ablegen setzt Feature |
|---|---|---|---|---|
| Offen | neu, offen | neu, wird geprüft | offen | wird geprüft |
| In Arbeit | in Bearbeitung | wird umgesetzt | in Bearbeitung | wird umgesetzt |
| Im Test | im Test | im Test | im Test | im Test |
| Wartet | wartend | – | wartend | nicht möglich |
| Fertig | gelöst | ist umgesetzt | gelöst | ist umgesetzt |

- `geschlossen` und `wird nicht umgesetzt` erscheinen nicht auf dem Board.
- Innerhalb einer Spalte: Priorität, dann Ticketnummer. Ausnahme „Fertig“: die letzten 20, neueste zuerst.

## Verhalten

- Rechner: Karten ziehen. Jede Karte hat zusätzlich ein Menü „Verschieben nach“ (Tastatur und Handy).
- Schmaler Bildschirm (Grenze wie heute, 900 px): eine Spalte auf einmal, Umschalter darüber, Verschieben nur per Menü.
- Antippen einer Karte klappt die Beschreibung auf.
- Filter nach Board und Label (für Ben zum Beispiel Label „Ben“).
- Schlägt das Speichern fehl, springt die Karte zurück, mit Meldung.
- Rolle `viewer`: nur ansehen.

## Schutz in öffentlichen Workspaces

Der heutige Statuswechsel gibt einen noch nicht freigegebenen Eintrag automatisch frei und kann den Einreichenden eine Mail schicken. Ziehen darf beides nicht versehentlich auslösen:

- Nicht freigegebene Einträge stehen **nicht** auf dem Board; sie werden wie bisher unter „Einträge“ freigegeben. Das Board nennt ihre Anzahl.
- Kann ein Wechsel eine Mail auslösen (Eintrag von außen eingereicht), fragt das Board vorher nach. Bei per API angelegten Einträgen fragt es nicht.

## Nicht in diesem Schritt

Einträge im Board anlegen oder bearbeiten, Reihenfolge von Hand, Live-Aktualisierung, eigene Spalten, neuer Status „TestFlight“, Änderungen am alten Board.

## Bau

- Nur `public/tenant-admin.{html,js}` und ein neues `public/board-model.js` mit den Zuordnungen als reine Funktionen (mit `node --test` geprüft). Vorhandene Route für den Statuswechsel, keine Migration, keine Datei unter `api/`.
- Vor dem Bau `~/.claude/ux-regelwerk.md` lesen. Bei 375 px und am Rechner im Browser ansehen, auch im dunklen Modus, falls die Konsole ihn hat.
- Merge nach `main` deployt roadlight.pro, nur mit Bens OK.
