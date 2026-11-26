# Kanban-Board in der Konsole, Bauplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Reiter „Board“ in der Roadlight-Konsole, auf dem Einträge in fünf Spalten stehen und verschoben werden.

**Architecture:** Reine Zuordnungs- und Sortierlogik in `public/board-model.js`; Darstellung und Bedienung in der vorhandenen Konsole. Verschieben nutzt `updateStatus` und damit die vorhandene Route.

**Tech Stack:** Vanilla JS/HTML/CSS, `node --test`.

**Spec:** [2026-11-26-kanban-board-design.md](2026-11-26-kanban-board-design.md)

## Global Constraints

- Keine neue Datei unter `api/`, keine Migration, keine API-Änderung.
- Alt-Bereich (`public/admin.*`, `/api/apps…`) bleibt unverändert.
- Vor der Oberfläche `~/.claude/ux-regelwerk.md` lesen. Deutsche Texte mit Umlauten, Du-Form.
- Alle Werte aus Einträgen laufen durch `escapeHtml`.
- Keine `.env`/`.env.local` im Arbeitsordner; vor Testläufen `ls .env .env.local` (beide fehlen).
- Merge nach `main` (deployt roadlight.pro) nur mit Bens OK. Vor dem Merge genau ein frischer Opus-Review.

## Review Focus

1. Nicht freigegebener Eintrag: erscheint nie auf dem Board, nur in der Anzahl (Task 1).
2. Unbekannter oder leerer Status: Eintrag steht in „Offen“, er verschwindet nicht (Task 1).
3. Feature auf „Wartet“: nicht möglich, keine Anfrage (Task 1, 2).
4. HTML im Titel, Label oder Board-Namen: wird als Text gezeigt (Task 2).
5. Speichern schlägt fehl: Karte steht wieder in der alten Spalte, Meldung sichtbar (Task 2).

---

### Task 1: Board-Modell

**Files:** Create `public/board-model.js`, `tests/board-model.test.js`

**Interfaces:** Export wie `public/suggestion-search.js` (Browser: `window.BoardModel`, Node: `require`).
- `COLUMNS`: `[{key:'offen',label:'Offen'},{key:'arbeit',label:'In Arbeit'},{key:'test',label:'Im Test'},{key:'wartet',label:'Wartet'},{key:'fertig',label:'Fertig'}]`
- `columnFor(item) -> key | null` (`null` bei `!item.approved`, `geschlossen`, `wird nicht umgesetzt`)
- `statusFor(columnKey, type) -> status | null` laut Spaltentabelle der Spec
- `needsConfirm(item) -> boolean`: wahr, wenn `item.notificationEnabled` oder `userFingerprint` nicht mit `api:` beginnt (auch wenn er fehlt)
- `buildBoard(items, {appId = '', label = ''}) -> {columns: {[key]: {items, total}}, pendingCount, labels}`

- [ ] **Step 1: Failing tests**
  - jede Zeile der Spaltentabelle in beide Richtungen, für `ticket`, `bug`, `feature`; `statusFor('wartet','feature') === null`
  - `columnFor({approved:false,status:'neu'}) === null`; `columnFor({approved:true,status:'xyz'}) === 'offen'`; leerer Status ebenso
  - Sortierung (außer „Fertig“): `kritisch`, `hoch`, `mittel`, `niedrig`, dann `ticketNumber` zahlenrichtig (`TB-002` vor `TB-010`)
  - „Fertig“: höchstens 20, nach `tagUpdatedAt` (ersatzweise `createdAt`), neueste zuerst; `total` zählt alle
  - Filter `appId` und `label`; `pendingCount` zählt nicht freigegebene nach demselben Filter; `labels` ist die sortierte, eindeutige Liste aller Labels
  - `needsConfirm`: `{userFingerprint:'api:k1'}` falsch; `{userFingerprint:'1.2.3.4_abc'}`, `{}` und `{userFingerprint:'api:k1',notificationEnabled:true}` wahr
- [ ] **Step 2: Rot** `node --test tests/board-model.test.js` → FAIL (Modul fehlt)
- [ ] **Step 3: Implementieren**
- [ ] **Step 4: Grün** → PASS
- [ ] **Step 5: Commit** `feat: Zuordnung und Sortierung fürs Board`

### Task 2: Reiter „Board“

**Files:** Modify `public/tenant-admin.html`, `public/tenant-admin.js`; Create `tests/tenant-board.test.js` (Konsole mit nachgebautem DOM laden, Muster `tests/admin-escaping.test.js`)

**Interfaces:**
- Consumes: `window.BoardModel` (Task 1), `this.suggestions`, `this.apps`, `this.canManageWorkspace()`, `updateStatus(id, status)`.
- Produces: `renderBoard()`, `moveCard(id, columnKey)`.

- Reiter zwischen „Einträge“ und „Releases“, `data-view="board"`; `switchView` kennt `board`; `board-model.js` wird vor `tenant-admin.js` geladen.
- Über den Spalten: Auswahl „Board“ (`Alle`) und „Label“ (`alle`); darunter bei `pendingCount > 0`: „{n} Einträge warten auf Freigabe. Du findest sie unter Einträge.“
- Karte: Titel; Priorität nur bei `kritisch`/`hoch`; Ticketnummer; Board-Name, wenn „Alle“; Labels. Antippen klappt die Beschreibung auf.
- Menü „Verschieben nach“ je Karte (nur erlaubte Spalten außer der aktuellen); Ziehen und Ablegen zusätzlich ab 901 px.
- Bis 900 px: Umschalter mit Spaltenname und Anzahl, eine Spalte sichtbar, Start „In Arbeit“.
- `moveCard`: ohne Recht, ohne Zielstatus oder bei gleicher Spalte nichts tun; bei `needsConfirm` fragen: „Dieser Wechsel kann eine E-Mail an die einreichende Person schicken. Trotzdem verschieben?“; danach `updateStatus`, am Ende immer `renderBoard()`.
- Rolle ohne `canManageWorkspace()`: kein Menü, nicht ziehbar.
- `loadSuggestions` ruft auch `renderBoard()` auf.

- [ ] **Step 1: Failing tests**: Titel `<img src=x onerror=alert(1)>` erscheint maskiert; `moveCard` sendet `PUT …/suggestions/:id/status` mit dem Status der Tabelle; Feature nach `wartet` sendet nichts; abgelehnte Rückfrage sendet nichts; API-Eintrag fragt nicht; bei Fehlerantwort bleibt die Karte in der alten Spalte und die Meldung erscheint; `viewer` bekommt kein Menü; nicht freigegebener Eintrag fehlt, Hinweis nennt die Anzahl.
- [ ] **Step 2: Rot** `node --test tests/tenant-board.test.js`
- [ ] **Step 3: Implementieren**, Farben und Abstände aus den vorhandenen CSS-Variablen.
- [ ] **Step 4: Grün** `npm test` → alle PASS
- [ ] **Step 5: Im Browser prüfen**: App mit `tests/fake-app.js` und Beispieldaten starten (Wegwerf-Skript im Scratchpad, nicht committen; Sitzung wie in `tests/invite-owner-role.test.js`). Bei 1280 px und 375 px: Spalten, Ziehen, Menü, Umschalter, Filter, kein seitliches Scrollen am Handy. Je ein Bildschirmfoto in die Rückmeldung.
- [ ] **Step 6: Commit** `feat: Kanban-Board in der Konsole`
