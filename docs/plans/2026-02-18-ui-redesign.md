# UI Redesign: Modern & Bold + Dark Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Voting-Tool UI auf Modern & Bold upgraden: Vote-Column links in Cards, Dark Mode mit Toggle, stärkere Typografie.

**Architecture:** Drei Dateien werden geändert — `style.css` (Dark-Mode-Variablen, Vote-Column-Layout, Animationen), `index.html` (Dark-Mode-Toggle-Button), `script.js` (Card-HTML-Template + Dark-Mode-Init). Keine API- und keine Admin-Änderungen.

**Tech Stack:** Vanilla CSS (CSS Custom Properties), Vanilla JS (localStorage), kein Build-Step.

---

### Task 1: Dark-Mode-CSS-Variablen in style.css

**Files:**
- Modify: `public/style.css`

**Context:**
Die Datei nutzt `:root { --background: #FFFFFF; ... }`. Wir fügen einen `[data-theme="dark"]`-Block hinzu, der alle relevanten Variablen überschreibt. Das `data-theme`-Attribut wird später per JS auf `<html>` gesetzt.

**Step 1: Dark-Mode-Variablen nach dem `:root`-Block einfügen**

Nach Zeile 74 (dem schließenden `}` des `:root`-Blocks) folgendes einfügen:

```css
[data-theme="dark"] {
    --background: #0F0F0F;
    --background-alt: #141414;
    --surface: #141414;
    --surface-elevated: #1A1A1A;
    --surface-hover: #1F1F1F;

    --text-primary: #F5F5F5;
    --text-secondary: #A0A0A0;
    --text-muted: #606060;
    --text-inverse: #0F0F0F;

    --border: #2A2A2A;
    --border-light: #222222;
    --border-focus: #6366F1;

    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.5);
    --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.6);
    --shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.7);
    --shadow-xl: 0 8px 24px rgba(0, 0, 0, 0.8);
    --shadow-floating: 0 12px 40px rgba(0, 0, 0, 0.9);

    --primary-light: rgba(99, 102, 241, 0.15);
    --success-light: rgba(16, 185, 129, 0.15);
    --danger-light: rgba(239, 68, 68, 0.15);
    --warning-light: rgba(245, 158, 11, 0.15);
}
```

**Step 2: Prüfen ob Datei korrekt gespeichert**

Datei öffnen, sicherstellen dass `[data-theme="dark"]` nach `:root { ... }` steht und korrekt geklammert ist.

**Step 3: Commit**

```bash
git add public/style.css
git commit -m "style: Add dark mode CSS variables"
```

---

### Task 2: Stärkere Typografie in style.css

**Files:**
- Modify: `public/style.css`

**Context:**
Aktuell ist `font-weight: 700` für Headings. Wir erhöhen auf `800` und passen Letter-Spacing an.

**Step 1: `.header h1` anpassen**

Bestehenden Block (ab Zeile 137):
```css
.header h1 {
    font-family: var(--font-heading);
    font-size: clamp(2.25rem, 5vw, 3.25rem);
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: var(--spacing-sm);
    letter-spacing: -0.02em;
    line-height: 1.15;
}
```
Ersetzen durch:
```css
.header h1 {
    font-family: var(--font-heading);
    font-size: clamp(2.25rem, 5vw, 3.5rem);
    font-weight: 800;
    color: var(--text-primary);
    margin-bottom: var(--spacing-sm);
    letter-spacing: -0.03em;
    line-height: 1.1;
}
```

**Step 2: `.app-card h3` und `.suggestion-title` auf 800 erhöhen**

`.app-card h3` (aktuell `font-weight: 700`): auf `font-weight: 800` setzen.

`.suggestion-title` (aktuell `font-weight: 700`): auf `font-weight: 700` lassen — dort passt es so (Card-Kontext ist kleinerer Text).

**Step 3: Commit**

```bash
git add public/style.css
git commit -m "style: Bolder typography (weight 800, tighter tracking)"
```

---

### Task 3: Vote-Column-Layout in style.css

**Files:**
- Modify: `public/style.css`

**Context:**
Aktuell hat `.suggestion-card` ein vertikales Layout mit `.suggestion-header` (Content) und `.suggestion-footer` (Vote-Button). Das neue Layout:

```
┌──────────────────────────────────┐
│  ▲   │  Titel                    │
│  42  │  Beschreibung             │
│      │  [Tag] [Kommentare]       │
└──────────────────────────────────┘
```

Die Vote-Column ist links, schmal, vertikal zentriert. Das Card-HTML ändert sich in Task 5.

**Step 1: `.suggestion-card`-Regel aktualisieren**

Bestehenden Block:
```css
.suggestion-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--spacing-xl);
    transition: var(--transition);
    position: relative;
}

.suggestion-card:hover {
    background: var(--surface-hover);
}
```

Ersetzen durch:
```css
.suggestion-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--spacing-xl);
    transition: var(--transition);
    position: relative;
}

.suggestion-card:hover {
    background: var(--surface-hover);
    transform: translateY(-1px);
    box-shadow: var(--shadow-md);
}

[data-theme="dark"] .suggestion-card:hover {
    box-shadow: none;
}
```

**Step 2: Neue Vote-Column-Klassen ans Ende der CSS-Datei anfügen (vor dem `@media`-Block)**

```css
/* Vote Column Layout */
.suggestion-layout {
    display: flex;
    gap: var(--spacing-lg);
    align-items: flex-start;
}

.vote-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    width: 44px;
    padding-top: 2px;
}

.upvote-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-muted);
    font-size: 1.1rem;
    line-height: 1;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    transition: color 0.12s ease, transform 0.12s ease;
    display: flex;
    align-items: center;
    justify-content: center;
}

.upvote-btn:hover:not(:disabled) {
    color: var(--primary-color);
}

.upvote-btn:active:not(:disabled) {
    transform: scale(1.2);
}

.upvote-btn.voted {
    color: var(--primary-color);
}

.upvote-btn:disabled {
    cursor: default;
    opacity: 0.4;
}

.vote-column .vote-count {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--text-muted);
    line-height: 1;
}

.vote-column .vote-count.voted {
    color: var(--primary-color);
}

.bug-icon-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex-shrink: 0;
    width: 44px;
    padding-top: 4px;
    color: var(--text-muted);
    font-size: 1rem;
    opacity: 0.5;
}

.suggestion-layout .suggestion-content {
    flex: 1;
    min-width: 0;
}
```

**Step 3: Alte `.suggestion-footer` und `.vote-btn`-Regeln entfernen**

Die folgenden Blöcke aus `style.css` löschen (sie werden nicht mehr gebraucht, da der Vote-Button durch `.upvote-btn` ersetzt wird):

- `.suggestion-footer { ... }` (Zeile ~572)
- `.vote-info { ... }` (Zeile ~578)
- `.vote-count { ... }` (die alte standalone-Regel, Zeile ~586)
- `.vote-btn { ... }` und alle `.vote-btn`-Varianten (Zeilen ~591–617)

**Achtung:** Die neue `.vote-column .vote-count`-Regel (aus Step 2) ersetzt die alte `.vote-count`-Regel. Nicht beide stehen lassen.

**Step 4: Mobile-Anpassungen für Vote-Column im `@media (max-width: 768px)`-Block ergänzen**

Im bestehenden `@media (max-width: 768px)` Block anfügen:
```css
    .vote-column {
        width: 36px;
    }

    .upvote-btn {
        padding: 4px 6px;
    }
```

**Step 5: Commit**

```bash
git add public/style.css
git commit -m "style: Vote column layout + card hover animation"
```

---

### Task 4: Dark-Mode-Toggle-Button in index.html

**Files:**
- Modify: `public/index.html`

**Context:**
Der bestehende Settings-Button (`.settings-btn`) sitzt oben rechts im Header. Der Dark-Mode-Toggle kommt daneben (links davon, oder als zweiter Button).

**Step 1: Dark-Mode-Toggle-Button im `<header>` einfügen**

Im `<header class="header">` (index.html, Zeile 15–18), nach dem öffnenden `<header>`-Tag und VOR dem `<h1>`, folgendes einfügen:

```html
<button class="theme-toggle-btn" id="themeToggleBtn" title="Dark Mode umschalten" aria-label="Dark Mode umschalten">
    <svg id="themeIcon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
    </svg>
</button>
```

Der Button zeigt zunächst das Mond-Icon (→ Dark Mode aktivieren). Im JS wird es dynamisch getauscht.

**Step 2: CSS für `.theme-toggle-btn` in style.css einfügen**

Nach dem `.settings-btn`-Block (Zeile ~135) einfügen:

```css
.theme-toggle-btn {
    position: absolute;
    top: var(--spacing-lg);
    right: 52px; /* 40px Button-Breite + 12px gap zum settings-btn */
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-secondary);
    transition: var(--transition);
    z-index: 10;
}

.theme-toggle-btn svg {
    width: 18px;
    height: 18px;
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.theme-toggle-btn:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
    border-color: var(--text-muted);
}
```

**Step 3: Commit**

```bash
git add public/index.html public/style.css
git commit -m "feat: Add dark mode toggle button to header"
```

---

### Task 5: Dark-Mode-Logik in script.js

**Files:**
- Modify: `public/script.js`

**Context:**
Dark Mode wird über `document.documentElement.setAttribute('data-theme', 'dark')` aktiviert. Der aktuelle Stand wird in `localStorage` gespeichert. Beim Laden: erst LocalStorage, dann `prefers-color-scheme`.

**Step 1: Dark-Mode-Init-Funktion zur Klasse hinzufügen**

In der `VotingApp`-Klasse, nach der `init()`-Methode (Zeile ~14), einfügen:

```js
initDarkMode() {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = saved ? saved === 'dark' : prefersDark;
    this.applyTheme(isDark ? 'dark' : 'light');
}

applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);

    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;

    const isDark = theme === 'dark';
    btn.setAttribute('title', isDark ? 'Light Mode aktivieren' : 'Dark Mode aktivieren');
    btn.innerHTML = isDark
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <circle cx="12" cy="12" r="5"/>
             <line x1="12" y1="1" x2="12" y2="3"/>
             <line x1="12" y1="21" x2="12" y2="23"/>
             <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
             <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
             <line x1="1" y1="12" x2="3" y2="12"/>
             <line x1="21" y1="12" x2="23" y2="12"/>
             <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
             <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
           </svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
             <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
           </svg>`;
}

toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    this.applyTheme(current === 'dark' ? 'light' : 'dark');
}
```

**Step 2: `initDarkMode()` in `init()` aufrufen**

Bestehende `init()`-Methode:
```js
init() {
    this.bindEvents();
    this.loadApps();
}
```
Ersetzen durch:
```js
init() {
    this.initDarkMode();
    this.bindEvents();
    this.loadApps();
}
```

**Step 3: Toggle-Button-Event in `bindEvents()` einfügen**

In `bindEvents()`, nach dem letzten `addEventListener`-Aufruf (Zeile ~28), einfügen:

```js
const themeBtn = document.getElementById('themeToggleBtn');
if (themeBtn) {
    themeBtn.addEventListener('click', () => this.toggleTheme());
}
```

**Step 4: Commit**

```bash
git add public/script.js
git commit -m "feat: Dark mode logic with localStorage + system preference"
```

---

### Task 6: Vote-Column-HTML in script.js

**Files:**
- Modify: `public/script.js`

**Context:**
Die `renderSuggestions`-Methode (Zeile 383) generiert das Card-HTML. Die `voteSuggestion`-Methode (Zeile 220) greift auf `button.parentElement.querySelector('.vote-count')` zu — das muss mit dem neuen DOM-Layout noch funktionieren.

Im neuen Layout liegt `.upvote-btn` und `.vote-count` beide im `.vote-column`-div, also ist `button.parentElement.querySelector('.vote-count')` weiterhin korrekt.

**Step 1: Card-HTML-Template in `renderSuggestions` ersetzen**

Das return-Statement der `suggestions.map`-Funktion (Zeilen 506–540) ersetzen:

```js
return `
    <div class="suggestion-card" style="${cardOpacity}">
        <div class="suggestion-layout">
            ${isBug
                ? `<div class="bug-icon-column">🐞</div>`
                : `<div class="vote-column">
                       <button
                           class="upvote-btn ${suggestion.hasVoted ? 'voted' : ''}"
                           ${suggestion.hasVoted || isImplemented ? 'disabled' : ''}
                           onclick="app.voteSuggestion('${suggestion.id}', this)"
                           title="${suggestion.hasVoted ? 'Vote entfernen' : 'Upvoten'}"
                       >▲</button>
                       <span class="vote-count ${suggestion.hasVoted ? 'voted' : ''}">${suggestion.votes || 0}</span>
                   </div>`
            }
            <div class="suggestion-content">
                <h3 class="suggestion-title">${this.escapeHtml(suggestion.title)}</h3>
                <p class="suggestion-description">${this.escapeHtml(suggestion.description)}</p>
                ${typeBadge}
                ${tagBadge}
                ${commentBadge}
                <div id="comments-${suggestion.id}" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-light);">
                    <div class="loading" style="font-size: 0.9rem;">Kommentare werden geladen...</div>
                </div>
            </div>
        </div>
    </div>
`;
```

**Step 2: `voteSuggestion`-Methode anpassen**

Die Methode (Zeile 220) greift auf `button.textContent` zu (`button.textContent = 'Gevotet'` etc.). Mit dem neuen `▲`-Icon-Button muss das geändert werden.

Bestehende Stellen in `voteSuggestion` wo `button.textContent` gesetzt wird:

```js
button.textContent = isVoted ? 'Removing...' : 'Voting...';
```
→ Entfernen (Button-Text ist jetzt immer `▲`, kein Loading-Text nötig).

```js
button.textContent = 'Vote';
button.classList.remove('voted');
voteCountEl.textContent = Math.max(0, currentCount - 1);
```
→ Ersetzen durch:
```js
button.classList.remove('voted');
voteCountEl.classList.remove('voted');
voteCountEl.textContent = Math.max(0, currentCount - 1);
```

```js
button.textContent = 'Gevotet';
button.classList.add('voted');
voteCountEl.textContent = currentCount + 1;
```
→ Ersetzen durch:
```js
button.classList.add('voted');
voteCountEl.classList.add('voted');
voteCountEl.textContent = currentCount + 1;
```

Auch die Error-Fallbacks am Ende anpassen:
```js
button.textContent = isVoted ? 'Gevotet' : 'Vote';
```
→ Diese Zeile einfach löschen (Button-Icon bleibt immer `▲`).

**Step 3: Manuell im Browser testen**

1. App öffnen → Suggestion-Cards zeigen Vote-Column links mit `▲`
2. Auf `▲` klicken → Zahl erhöht sich, Icon wird Indigo
3. Erneut klicken → Zahl sinkt, Icon grau
4. Bug-Cards → zeigen `🐞` statt Vote-Column

**Step 4: Commit**

```bash
git add public/script.js
git commit -m "feat: Vote column UI (upvote arrow + count)"
```

---

### Task 7: Push & Deploy

**Step 1: Push**

```bash
git push origin main
```

**Step 2: Vercel deployed automatisch — Status prüfen**

```bash
npx vercel ls | head -3
```

Erwartet: neue Deployment-URL ganz oben.

**Step 3: Funktionstest auf Produktions-URL**

- Light Mode: Cards mit Vote-Column
- Dark Mode Toggle: Mond-Icon → Sonne-Icon, Theme wechselt
- Nach Reload: Dark Mode bleibt erhalten
- Vote: Klick auf ▲ → Zahl erhöht sich
- Mobile: Vote-Column auf kleinem Screen noch gut lesbar
