# Direct URLs Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Die Public-App soll per Direct-URL direkt auf eine App, deren Roadmap, deren Changelog und einzelne Einträge verlinkbar sein, inklusive funktionierendem Reload und Browser-Back/Forward.

**Architecture:** Die bestehende Single-Page-App bleibt erhalten, bekommt aber eine kleine URL-State-Synchronisierung auf Basis von `window.location.search` und `history.pushState` bzw. `history.replaceState`. Die URL hält nur den minimalen Zustand (`appId`, `view`, optional `suggestionId`) und synchronisiert diesen mit der bestehenden UI-Logik.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Express, Firebase/Firestore, `node:test`

---

## Geprüfter Ist-Zustand

- `public/script.js` verwaltet Navigation derzeit nur über In-Memory-State (`currentApp`, `currentView`) und verliert den Zustand bei Reload.
- `public/script.js` lädt Einträge, Roadmap und Changelog bereits getrennt, aber ohne URL-Synchronisierung.
- `public/script.js` rendert Einträge nur als Liste; es gibt aktuell keine dedizierte Entry-Detail-View.
- `api/index.js` serviert statische Dateien und `/admin`, hat aber noch keinen expliziten SPA-Fallback für Public-Routen wie `/apps/:appId/...`.
- `vercel.json` leitet bereits alle Requests an `api/index.js`, daher muss der Fallback serverseitig sauber zwischen API/Admin und Public-Routen unterscheiden.

## Gewünschter Zielzustand

Beim Aufruf der FamilyManager-Roadmap-URL soll die App direkt in diesen Zustand hydratisieren:

- `FamilyManager` ist bereits als aktive App ausgewählt
- der Header zeigt `FamilyManager`
- der Tab `Roadmap` ist aktiv
- die Einträge-Liste ist ausgeblendet
- die Roadmap-Releases sind sichtbar
- die Seite landet ohne zusätzlichen Klick direkt im Public-View der App

## Empfohlenes URL-Schema

- App-Übersicht: `/`
- App, Einträge: `/?appId=<appId>`
- App, Roadmap: `/?appId=<appId>&view=roadmap`
- App, Changelog: `/?appId=<appId>&view=changelog`
- App, einzelner Eintrag: `/?appId=<appId>&view=suggestions&suggestionId=<suggestionId>`

Beispiel für den gewünschten Zielzustand:

- FamilyManager Roadmap: `/?appId=<familyManagerId>&view=roadmap`

## Wichtige Architekturentscheidung

- Die aktuelle App-Struktur verwendet Firestore-Dokument-IDs als `id`.
- Weil dir die URL-Form egal ist, nutzen wir diese bestehenden IDs direkt weiter.
- Dadurch brauchen wir keine Slugs, keine Datenmigration und sehr wahrscheinlich keinen zusätzlichen Express-Fallback für neue Pfade.

## Produktentscheidung für Eintrags-URLs

- Phase 1 sollte **keine neue Detailseite** bauen.
- Ein Entry-Deep-Link öffnet weiterhin die Eintragsliste der App, scrollt zum Ziel-Eintrag und hebt ihn visuell hervor.
- Optional: Wenn der Eintrag Kommentare hat, kann der Deep-Link die Kommentare automatisch aufklappen.

## Randfälle

- Unbekannte `appId`: Fallback auf App-Auswahl plus Toast/Fehlermeldung.
- Unbekannte `suggestionId` innerhalb einer gültigen App: App und View bleiben offen, aber es gibt einen Hinweis, dass der Eintrag nicht gefunden wurde.
- Leere Roadmap oder leeres Changelog behalten ihr bestehendes Empty State.
- Browser Back/Forward darf nur Route-State wiederherstellen und keine doppelte Navigation auslösen.

## Chunk 1: Routing-Grundlage

### Task 1: Route-Modell definieren

**Files:**
- Modify: `public/script.js`
- Test: `tests/direct-urls.test.js`

- [ ] **Step 1: Reines Route-State-Modell festlegen**

Definiere ein minimales internes Modell:

```js
{
  appId: null,
  view: 'suggestions',
  suggestionId: null,
}
```

- [ ] **Step 2: Parser und Serializer als pure Helper anlegen**

Benötigte Helfer:

```js
parseUrlState(search)
buildUrlState({ appId, view, suggestionId })
normalizeView(view)
```

- [ ] **Step 3: Failing Tests für Route-Parsen schreiben**

Beispiel:

```js
assert.deepEqual(parseUrlState(''), {
  appId: null,
  view: 'suggestions',
  suggestionId: null,
});

assert.deepEqual(parseUrlState('?appId=abc123&view=roadmap'), {
  appId: 'abc123',
  view: 'roadmap',
  suggestionId: null,
});

assert.equal(
  buildUrlState({ appId: 'abc123', view: 'changelog', suggestionId: null }),
  '?appId=abc123&view=changelog'
);
```

- [ ] **Step 4: Tests ausführen und FAIL verifizieren**

Run: `node --test tests/direct-urls.test.js`
Expected: FAIL, weil Parser/Serializer noch nicht existieren.

- [ ] **Step 5: Minimalen Parser/Serializer implementieren**

Route-Mapping:

```txt
/ -> appId=null
/?appId=<id> -> view=suggestions
/?appId=<id>&view=roadmap -> view=roadmap
/?appId=<id>&view=changelog -> view=changelog
/?appId=<id>&view=suggestions&suggestionId=<id> -> view=suggestions
```

- [ ] **Step 6: Tests erneut ausführen**

Run: `node --test tests/direct-urls.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add public/script.js tests/direct-urls.test.js
git commit -m "feat: add client-side direct url route model"
```

### Task 2: App-Initialisierung auf Route-State umstellen

**Files:**
- Modify: `public/script.js`
- Test: `tests/direct-urls.test.js`

- [ ] **Step 1: Boot-Sequenz definieren**

Beim Start:

1. Apps laden
2. Aktuelle Query-Parameter parsen
3. Falls `appId` vorhanden: passende App selektieren
4. Danach passenden View laden
5. Optionalen `suggestionId` anwenden

Die Selektion muss explizit den Screenshot-Zustand herstellen, z. B. für `/?appId=<familyManagerId>&view=roadmap` direkt in die Roadmap-Ansicht von FamilyManager.

- [ ] **Step 2: `popstate`-Handling ergänzen**

Benötigt:

```js
window.addEventListener('popstate', () => this.applyRouteFromLocation());
```

- [ ] **Step 3: Navigation in bestehende UI integrieren**

Neue Methoden:

```js
navigateToUrlState(state, { replace = false } = {})
applyUrlState(state, options)
applyUrlStateFromLocation()
```

- [ ] **Step 4: Testfälle für Initialisierung und Back/Forward ergänzen**

Mindestens per Strukturtest absichern:

- `script.js` enthält `pushState` oder `replaceState`
- `script.js` registriert `popstate`
- Route-Anwendung ruft bestehende Loader gezielt je View auf

- [ ] **Step 5: Tests ausführen**

Run: `node --test tests/direct-urls.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add public/script.js tests/direct-urls.test.js
git commit -m "feat: wire direct url routing into app lifecycle"
```

## Chunk 2: UI-Navigation auf URLs abbilden

### Task 3: App-Karten und Tabs auf Route-Navigation umstellen

**Files:**
- Modify: `public/script.js`
- Modify: `public/index.html`
- Test: `tests/direct-urls.test.js`

- [ ] **Step 1: App-Auswahl nicht mehr nur lokal schalten**

`selectApp()` soll künftig die URL `/?appId=<id>` setzen und danach die bestehende UI aktualisieren.

- [ ] **Step 2: Tabs auf URL-Änderung umstellen**

`switchView('roadmap')` soll auf `/?appId=<id>&view=roadmap` navigieren, `switchView('changelog')` auf `/?appId=<id>&view=changelog`.

- [ ] **Step 3: Zurück-Buttons klar definieren**

- Public Back aus App-View führt zu `/`
- Form-Back führt zurück zur aktuellen App-Route, ohne neuen URL-Zweig zu erzeugen

- [ ] **Step 4: Testfälle für Link-Ziele ergänzen**

Prüfen, dass:

- App-Karten weiterhin eine Auswahl triggern
- Tabs nicht nur DOM togglen, sondern Route-Navigation auslösen
- Root-Navigation App-State zurücksetzt

- [ ] **Step 5: Tests ausführen**

Run: `node --test tests/direct-urls.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/script.js tests/direct-urls.test.js
git commit -m "feat: sync app and tab navigation with direct urls"
```

### Task 4: Eintrags-Deep-Linking ergänzen

**Files:**
- Modify: `public/script.js`
- Modify: `public/style.css`
- Test: `tests/direct-urls.test.js`

- [ ] **Step 1: Ziel-Eintrag im DOM adressierbar machen**

Jede Karte braucht eine stabile ID, z. B.:

```html
<div id="suggestion-<id>" class="suggestion-card">
```

- [ ] **Step 2: Klickpfade für Einträge definieren**

Ein dedizierter CTA oder klickbarer Titel soll auf `/?appId=<id>&view=suggestions&suggestionId=<suggestionId>` navigieren.

- [ ] **Step 3: Route-Anwendung für `suggestionId` bauen**

Nach Laden der Einträge:

1. Zielkarte finden
2. sanft scrollen
3. temporär highlighten
4. optional Kommentare öffnen

- [ ] **Step 4: Highlight-Styling ergänzen**

Beispiel:

```css
.suggestion-card.is-route-target {
  outline: 2px solid var(--color-accent);
  box-shadow: 0 0 0 6px color-mix(in srgb, var(--color-accent) 16%, transparent);
}
```

- [ ] **Step 5: Tests für Entry-Deep-Link-Mechanik ergänzen**

Prüfen, dass:

- `entries/:suggestionId` vom Parser erkannt wird
- Zielkarten eine adressierbare ID erhalten
- Script einen Highlight-/Scroll-Pfad enthält

- [ ] **Step 6: Tests ausführen**

Run: `node --test tests/direct-urls.test.js`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add public/script.js public/style.css tests/direct-urls.test.js
git commit -m "feat: add deep links for individual entries"
```

## Chunk 3: Absicherung und Doku

### Task 5: Query-basierte Direktlinks absichern

**Files:**
- Modify: `public/script.js`
- Test: `tests/direct-urls.test.js`

- [ ] **Step 1: Query-State robust anwenden**

- URL-State darf beim Laden und bei `popstate` keine doppelten Loader oder widersprüchlichen UI-Wechsel auslösen.

- [ ] **Step 2: Replace-vs-Push sauber trennen**

- Initiale Hydratisierung sollte `replaceState` nutzen oder ganz ohne History-Eintrag auskommen.
- Nutzeraktionen wie App-Wechsel oder Tab-Wechsel sollen `pushState` nutzen.

- [ ] **Step 3: Tests für Query-State ergänzen**

String-basierte Absicherung reicht zunächst:

- `script.js` liest `window.location.search`
- `script.js` schreibt Query-Parameter konsistent zurück
- `script.js` behandelt leere oder unvollständige Query-Parameter robust

- [ ] **Step 4: Tests ausführen**

Run: `node --test tests/direct-urls.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add public/script.js tests/direct-urls.test.js
git commit -m "feat: stabilize query-based direct urls"
```

### Task 6: Regressionen und Doku absichern

**Files:**
- Modify: `README.md`
- Modify: `tests/mobile-header.test.js`
- Test: `tests/direct-urls.test.js`

- [ ] **Step 1: Vorhandene UI-Regressionen gegenprüfen**

Bestehende Mobile-Header-Tests müssen weiter grün bleiben.

- [ ] **Step 2: README um URL-Beispiele erweitern**

Dokumentiere mindestens:

- `/?appId=<appId>`
- `/?appId=<appId>&view=roadmap`
- `/?appId=<appId>&view=changelog`
- `/?appId=<appId>&view=suggestions&suggestionId=<suggestionId>`

- [ ] **Step 3: Gesamte Test-Suite laufen lassen**

Run: `node --test tests/*.test.js`
Expected: PASS

- [ ] **Step 4: Manuelle Smoke-Checks durchführen**

Prüfen:

1. App-Karte anklicken -> URL ändert sich
2. Reload auf App-URL -> gleiche View bleibt offen
3. Roadmap-URL direkt öffnen -> Roadmap erscheint
4. Changelog-URL direkt öffnen -> Changelog erscheint
5. Entry-URL direkt öffnen -> Zielkarte wird sichtbar und markiert
6. Browser Back/Forward folgt der View-Historie

- [ ] **Step 5: Commit**

```bash
git add README.md tests/mobile-header.test.js tests/direct-urls.test.js
git commit -m "docs: document and verify public direct urls"
```

## Offene Entscheidung

- Soll ein Eintrags-Link in Phase 1 nur zur Karte scrollen und highlighten, oder möchtest du direkt eine echte Detailansicht/Modal mit eigener URL?
