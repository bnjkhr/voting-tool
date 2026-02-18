# UI Redesign: Modern & Bold + Dark Mode

**Datum:** 2026-02-18
**Status:** Approved

## Ziel

Das Voting-Tool erhält ein visuell stärkeres, moderneres Erscheinungsbild. Kein Redesign der Architektur — nur CSS und minimale HTML-Änderungen in den dynamisch gerenderten Cards.

## Entscheidungen

- **Stil:** Modern & Bold (wie Linear/Vercel) — kräftige Typografie, hoher Kontrast
- **Dark Mode:** Ja, mit System-Preference-Default + manuellem Toggle (LocalStorage)
- **Vote-UI:** Upvote-Arrow-Column links im Card (▲ Icon + Zahl darunter)

## Änderungen

### 1. Typografie
- Headings: `font-weight: 800`, mehr `letter-spacing`
- Größen leicht angehoben für Hierarchie

### 2. Vote-Column
- Suggestion-Cards bekommen zweispaltiges Layout: links Vote-Spalte, rechts Content
- Vote-Spalte: `▲` Icon oben, Zahl darunter, vertikal zentriert
- Aktiv-State (gevoted): Indigo-Farbe für Icon + Zahl
- Bug-Cards: keine Vote-Spalte (wie bisher), nur Severity-Badge

### 3. Dark Mode
- CSS-Variable-Set für `[data-theme="dark"]`
- Background: `#0F0F0F`, Cards: `#141414`, Borders: `#2A2A2A`
- Text: `#F5F5F5` primary, `#A0A0A0` secondary
- Indigo-Akzent bleibt identisch
- Toggle-Button oben rechts (Mond/Sonne Icon), speichert in `localStorage`
- `prefers-color-scheme: dark` als Default wenn kein LocalStorage-Wert

### 4. Card-Verfeinerungen
- Hover: `translateY(-1px)` + leicht stärkerer Shadow im Light Mode
- Border im Dark Mode: `1px solid #2A2A2A` (kein Shadow)
- Vote-Button: kleiner Bounce-Scale beim Klick (`scale(1.15)` → `scale(1)`)

### 5. Filter-Pills
- Dark-Mode-Anpassung der Farben
- Aktive Pill: bleibt Indigo

## Dateien

| Datei | Änderung |
|-------|----------|
| `public/style.css` | Dark-Mode-Variablen, Vote-Column-Layout, Typo, Animationen |
| `public/index.html` | Dark-Mode-Toggle-Button im Header |
| `public/script.js` | Card-HTML-Template auf Vote-Column umstellen, Dark-Mode-Init |

## Nicht geändert

- Admin-Seite (`admin.html`, `admin.js`)
- API (`api/index.js`)
- Formulare (Struktur bleibt, nur Styling via bestehende Klassen)
- Alle Funktionen bleiben identisch
