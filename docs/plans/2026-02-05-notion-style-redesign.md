# Notion-Style UI Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign des gesamten Voting-Tools (User-Seite + Admin) zu einem modernen, bold Notion-Style mit Serif-Headings, Monochrom+Indigo-Palette und Mobile-First.

**Architecture:** Reines CSS-Redesign + minimale HTML-Anpassungen. Kein JS-Refactor nötig. Alle Änderungen in `style.css`, `index.html` und `admin.html`. Google Fonts wird nicht benötigt - Georgia als Serif-Font ist systemseitig verfügbar.

**Tech Stack:** HTML, CSS (Custom Properties), keine neuen Dependencies

---

## Design-Spezifikation

### Farbpalette
| Token | Wert | Verwendung |
|---|---|---|
| `--bg` | `#FFFFFF` | Haupt-Hintergrund |
| `--bg-secondary` | `#F7F7F5` | Sekundäre Flächen, Filter-Bar |
| `--surface` | `#FFFFFF` | Cards |
| `--text-primary` | `#1A1A1A` | Headlines, wichtiger Text |
| `--text-secondary` | `#6B7280` | Beschreibungen |
| `--text-muted` | `#9CA3AF` | Placeholder, inaktiv |
| `--border` | `#E5E5E3` | Subtile Trennlinien |
| `--accent` | `#4F46E5` | Indigo - CTAs, Vote-Buttons |
| `--accent-hover` | `#4338CA` | Dunkleres Indigo |
| `--accent-light` | `#EEF2FF` | Badges, leichter Akzent-BG |
| `--accent-subtle` | `#C7D2FE` | Indigo ring/outline |

### Typografie
- **Headlines**: `Georgia, 'Times New Roman', serif` - bold, -0.03em
- **Body**: `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif`
- **H1**: `clamp(2.5rem, 6vw, 3.5rem)` / font-weight: 700
- **H2**: `clamp(1.5rem, 4vw, 2rem)` / font-weight: 700
- **H3**: `clamp(1.2rem, 3vw, 1.5rem)` / font-weight: 600
- **Body**: `1rem` / line-height: 1.6

### Design-Prinzipien
- Keine Box-Shadows auf Cards (Notion-flat)
- Nur subtile 1px Borders wo nötig
- Hover = Background-Shift, nicht Shadow-Lift
- Großzügiger Whitespace
- Mobile-First: Alle Werte per `clamp()` fluid

---

## Task 1: CSS Custom Properties & Typografie-Basis ersetzen

**Files:**
- Modify: `public/style.css:1-76` (`:root` Block komplett ersetzen)

**Step 1: Custom Properties Block ersetzen**

Ersetze den gesamten `:root`-Block in `style.css` mit der neuen Palette:

```css
:root {
    /* Notion-style Palette */
    --bg: #FFFFFF;
    --bg-secondary: #F7F7F5;
    --surface: #FFFFFF;

    /* Text */
    --text-primary: #1A1A1A;
    --text-secondary: #6B7280;
    --text-muted: #9CA3AF;
    --text-inverse: #FFFFFF;

    /* Accent: Indigo */
    --accent: #4F46E5;
    --accent-hover: #4338CA;
    --accent-light: #EEF2FF;
    --accent-subtle: #C7D2FE;

    /* Status Colors */
    --success-color: #10B981;
    --success-light: #D1FAE5;
    --danger-color: #EF4444;
    --danger-light: #FEE2E2;
    --warning-color: #F59E0B;
    --warning-light: #FEF3C7;

    /* Borders */
    --border: #E5E5E3;
    --border-light: #F3F3F1;

    /* Shadows - minimal, Notion-style */
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.04);
    --shadow: 0 1px 3px rgba(0,0,0,0.06);
    --shadow-md: 0 4px 12px rgba(0,0,0,0.08);
    --shadow-lg: 0 8px 24px rgba(0,0,0,0.1);
    --shadow-floating: 0 16px 40px rgba(0,0,0,0.12);

    /* Typography */
    --font-serif: Georgia, 'Times New Roman', serif;
    --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', sans-serif;

    /* Border Radius - tighter, less rounded */
    --radius-xs: 3px;
    --radius-sm: 4px;
    --radius: 6px;
    --radius-md: 8px;
    --radius-lg: 10px;
    --radius-xl: 12px;
    --radius-full: 9999px;

    /* Spacing */
    --spacing-xs: 0.25rem;
    --spacing-sm: 0.5rem;
    --spacing: 0.75rem;
    --spacing-md: 1rem;
    --spacing-lg: 1.5rem;
    --spacing-xl: 2rem;
    --spacing-2xl: 3rem;
    --spacing-3xl: 4rem;

    /* Transitions - snappy */
    --transition: all 0.15s ease;
    --transition-fast: all 0.1s ease;
    --transition-slow: all 0.2s ease;
}
```

**Step 2: Body-Styles aktualisieren**

Ersetze den `body`-Style:

```css
body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--text-primary);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    -webkit-tap-highlight-color: transparent;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
}
```

**Step 3: Verify** - Seite im Browser öffnen. Einige Variablen-Referenzen werden brechen (z.B. `--primary-color`, `--background`). Das ist erwartet und wird in den nächsten Tasks behoben.

**Step 4: Commit**
```bash
git add public/style.css
git commit -m "feat: replace CSS custom properties with Notion-style palette"
```

---

## Task 2: Header-Redesign (User-Seite)

**Files:**
- Modify: `public/style.css` (Header-Styles)
- Modify: `public/index.html:15-19` (Header HTML)

**Step 1: HTML anpassen**

Ersetze den Header in `index.html`:

```html
<header class="header">
    <h1>Feature Voting</h1>
    <p class="header-subtitle">Schlage neue Features vor oder vote für bestehende Ideen</p>
    <button class="settings-btn" id="settingsBtn" title="Einstellungen">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
</header>
```

**Step 2: CSS-Header-Styles ersetzen**

```css
.header {
    text-align: center;
    margin-bottom: var(--spacing-3xl);
    padding: var(--spacing-3xl) 0 var(--spacing-2xl);
    position: relative;
}

.header h1 {
    font-family: var(--font-serif);
    font-size: clamp(2.5rem, 6vw, 3.5rem);
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: var(--spacing-sm);
    letter-spacing: -0.03em;
    line-height: 1.1;
}

.header-subtitle {
    font-size: clamp(1rem, 2.5vw, 1.125rem);
    color: var(--text-secondary);
    font-weight: 400;
    max-width: 500px;
    margin: 0 auto;
}
```

Entferne die `header::before`-Regel (die dekorative Linie oben).

**Step 3: Settings-Button mit SVG-Icon updaten**

```css
.settings-btn {
    position: absolute;
    top: var(--spacing-xl);
    right: 0;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    color: var(--text-muted);
    transition: var(--transition);
}

.settings-btn:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
    border-color: var(--text-muted);
}
```

**Step 4: Commit**
```bash
git add public/style.css public/index.html
git commit -m "feat: redesign header with serif typography and minimal style"
```

---

## Task 3: App-Grid Cards Redesign

**Files:**
- Modify: `public/style.css` (App-Card Styles)

**Step 1: App-Selection und Card-Styles ersetzen**

```css
.app-selection h2 {
    font-family: var(--font-serif);
    font-size: clamp(1.5rem, 4vw, 2rem);
    font-weight: 700;
    margin-bottom: var(--spacing-xl);
    color: var(--text-primary);
    text-align: center;
    letter-spacing: -0.02em;
}

.app-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: var(--spacing-md);
}

.app-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--spacing-xl) var(--spacing-lg);
    cursor: pointer;
    transition: var(--transition);
    position: relative;
}

.app-card::before {
    display: none; /* Entferne die animierte Top-Border */
}

.app-card:hover {
    background: var(--bg-secondary);
    border-color: var(--text-muted);
    transform: none; /* Kein Lift-Effekt */
    box-shadow: none;
}

.app-card h3 {
    font-family: var(--font-serif);
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--spacing-sm);
    letter-spacing: -0.01em;
    line-height: 1.3;
}

.app-card p {
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.5;
}
```

**Step 2: Commit**
```bash
git add public/style.css
git commit -m "feat: redesign app cards with flat Notion-style look"
```

---

## Task 4: Suggestion Cards & Vote-Button Redesign

**Files:**
- Modify: `public/style.css` (Suggestion-Card und Vote-Button Styles)

**Step 1: Suggestion-Card Styles ersetzen**

```css
.suggestions-list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-md);
}

.suggestion-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--spacing-lg) var(--spacing-xl);
    transition: var(--transition);
    position: relative;
}

.suggestion-card::before {
    display: none; /* Entferne die linke farbige Border */
}

.suggestion-card:hover {
    background: var(--bg-secondary);
    border-color: var(--text-muted);
    box-shadow: none;
    transform: none;
}

.suggestion-title {
    font-family: var(--font-serif);
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--spacing-xs);
    letter-spacing: -0.01em;
    line-height: 1.3;
}

.suggestion-description {
    color: var(--text-secondary);
    font-size: 0.9375rem;
    line-height: 1.5;
    margin-bottom: var(--spacing-sm);
}
```

**Step 2: Vote-Button in Indigo**

```css
.vote-btn {
    background: var(--accent);
    color: var(--text-inverse);
    border: none;
    padding: 8px 20px;
    border-radius: var(--radius);
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition);
    min-width: 90px;
}

.vote-btn:hover {
    background: var(--accent-hover);
    transform: none;
    box-shadow: none;
}

.vote-btn:active {
    transform: scale(0.97);
}

.vote-btn:disabled {
    background: var(--bg-secondary);
    color: var(--text-muted);
    cursor: not-allowed;
}

.vote-btn.voted {
    background: var(--accent);
    color: var(--text-inverse) !important;
    box-shadow: none;
}
```

**Step 3: Vote-Count**
```css
.vote-count {
    font-weight: 700;
    color: var(--accent);
}
```

**Step 4: Commit**
```bash
git add public/style.css
git commit -m "feat: redesign suggestion cards and vote buttons with Indigo accent"
```

---

## Task 5: Buttons, FAB & Navigation Redesign

**Files:**
- Modify: `public/style.css` (Button-Styles)

**Step 1: Primary/Secondary Buttons**

```css
.primary-btn, .secondary-btn {
    padding: 10px 20px;
    border-radius: var(--radius);
    font-size: 0.9375rem;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition);
    border: none;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing-sm);
    letter-spacing: 0;
}

.primary-btn {
    background: var(--accent);
    color: var(--text-inverse);
}

.primary-btn:hover {
    background: var(--accent-hover);
    transform: none;
    box-shadow: none;
}

.primary-btn:active {
    transform: scale(0.97);
}

.primary-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

.secondary-btn {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
}

.secondary-btn:hover {
    background: var(--bg-secondary);
    border-color: var(--text-muted);
    color: var(--text-primary);
    transform: none;
    box-shadow: none;
}
```

**Step 2: FAB**

```css
.fab {
    position: fixed;
    bottom: var(--spacing-xl);
    right: var(--spacing-xl);
    width: 56px;
    height: 56px;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--text-inverse);
    border: none;
    cursor: pointer;
    box-shadow: var(--shadow-md);
    transition: var(--transition);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.5rem;
    z-index: 1000;
}

.fab:hover {
    background: var(--accent-hover);
    box-shadow: var(--shadow-lg);
    transform: none;
}

.fab:active {
    transform: scale(0.95);
}
```

**Step 3: Back-Button & View-Header**

```css
.view-header {
    display: flex;
    align-items: center;
    gap: var(--spacing-md);
    margin-bottom: var(--spacing-xl);
}

.view-header h2 {
    font-family: var(--font-serif);
    font-size: clamp(1.5rem, 4vw, 2rem);
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.02em;
}

.back-btn {
    background: transparent;
    border: 1px solid var(--border);
    width: 36px;
    height: 36px;
    border-radius: var(--radius);
    cursor: pointer;
    color: var(--text-secondary);
    transition: var(--transition);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 1rem;
    flex-shrink: 0;
}

.back-btn::before {
    content: '←';
    font-size: 1rem;
}

.back-btn:hover {
    background: var(--bg-secondary);
    border-color: var(--text-muted);
    color: var(--text-primary);
    transform: none;
    box-shadow: none;
}
```

**Step 4: Commit**
```bash
git add public/style.css
git commit -m "feat: redesign buttons, FAB, and navigation to Notion-style"
```

---

## Task 6: Filter-Bar & Labels Redesign

**Files:**
- Modify: `public/style.css` (Filter und Label Styles)

**Step 1: Filter-Bar**

```css
.filter-bar {
    display: flex;
    gap: 6px;
    flex-wrap: nowrap;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
    margin-bottom: var(--spacing-lg);
    padding: 4px;
}

.filter-bar::-webkit-scrollbar {
    display: none;
}

.filter-pill {
    --filter-color: var(--text-primary);
    appearance: none;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
    border-radius: var(--radius);
    padding: 6px 12px;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: var(--transition);
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    flex-shrink: 0;
}

.filter-pill:hover {
    background: var(--bg-secondary);
    color: var(--text-primary);
}

.filter-pill.active {
    background: var(--text-primary);
    border-color: var(--text-primary);
    color: var(--text-inverse);
}

.filter-count {
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    background: var(--bg-secondary);
    color: var(--text-muted);
    font-size: 0.6875rem;
    font-weight: 600;
}

.filter-pill.active .filter-count {
    background: rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.9);
}
```

**Step 2: Labels**

```css
.label {
    --label-color: var(--text-primary);
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: var(--radius-sm);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--label-color);
    background: color-mix(in srgb, var(--label-color) 8%, transparent);
    border: none;
    line-height: 1.2;
}

.label-dot {
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--label-color);
    flex: 0 0 auto;
}

.label-button {
    cursor: pointer;
    transition: var(--transition);
}

.label-button:hover {
    background: color-mix(in srgb, var(--label-color) 14%, transparent);
}
```

**Step 3: Commit**
```bash
git add public/style.css
git commit -m "feat: redesign filter bar (horizontal scroll) and labels"
```

---

## Task 7: Forms & Modal Redesign

**Files:**
- Modify: `public/style.css` (Form, Modal, Toast Styles)

**Step 1: Form-Styles**

```css
.form-group label {
    display: block;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: var(--spacing-sm);
    font-size: 0.875rem;
}

.form-group input,
.form-group textarea {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 0.9375rem;
    font-family: inherit;
    background: var(--surface);
    color: var(--text-primary);
    transition: var(--transition);
    resize: vertical;
}

.form-group input:focus,
.form-group textarea:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-light);
    transform: none;
}

.form-group input::placeholder,
.form-group textarea::placeholder {
    color: var(--text-muted);
}

.form-hint {
    color: var(--text-muted);
    font-size: 0.8125rem;
    margin-top: var(--spacing-xs);
}
```

**Step 2: Modal-Styles**

```css
.modal-backdrop {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(2px);
}

.modal-content {
    position: relative;
    background: var(--surface);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-floating);
    max-width: 480px;
    width: 90%;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}

.modal-header {
    padding: var(--spacing-lg) var(--spacing-xl);
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
}

.modal-header h2 {
    font-family: var(--font-serif);
    font-size: 1.25rem;
    font-weight: 700;
    letter-spacing: -0.01em;
}
```

**Step 3: Toast-Styles**

```css
.toast {
    position: fixed;
    top: var(--spacing-lg);
    right: var(--spacing-lg);
    padding: 10px 16px;
    background: var(--text-primary);
    border: none;
    border-radius: var(--radius);
    color: var(--text-inverse);
    font-weight: 500;
    font-size: 0.875rem;
    transform: translateY(-120%);
    opacity: 0;
    transition: all 0.2s ease;
    z-index: 1000;
    max-width: 360px;
}

.toast.show {
    transform: translateY(0);
    opacity: 1;
}

.toast.success {
    background: var(--text-primary);
}

.toast.error {
    background: var(--danger-color);
}

.toast.warning {
    background: var(--warning-color);
    color: var(--text-primary);
}
```

**Step 4: Commit**
```bash
git add public/style.css
git commit -m "feat: redesign forms, modals, and toasts"
```

---

## Task 8: Overlay & Animations Redesign

**Files:**
- Modify: `public/style.css` (Overlay und Animation Styles)

**Step 1: Overlay und Success-Screen**

```css
.overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.4);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    padding: var(--spacing-lg);
    animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}

.overlay-content {
    background: var(--surface);
    border-radius: var(--radius-lg);
    padding: var(--spacing-2xl);
    max-width: 420px;
    width: 100%;
    box-shadow: var(--shadow-floating);
    text-align: center;
    animation: slideUp 0.2s ease;
}

@keyframes slideUp {
    from { transform: translateY(16px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
}

.overlay-icon {
    width: 64px;
    height: 64px;
    background: var(--accent);
    border-radius: var(--radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 2rem;
    color: white;
    margin: 0 auto 20px auto;
    animation: scaleIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes scaleIn {
    from { transform: scale(0); }
    to { transform: scale(1); }
}
```

**Step 2: Commit**
```bash
git add public/style.css
git commit -m "feat: redesign overlays and simplify animations"
```

---

## Task 9: Mobile Responsive Redesign

**Files:**
- Modify: `public/style.css` (alle `@media` Queries)

**Step 1: Ersetze alle bestehenden Media-Queries**

```css
/* Tablet */
@media (max-width: 768px) {
    .container {
        padding: var(--spacing-md);
    }

    .header {
        margin-bottom: var(--spacing-2xl);
        padding: var(--spacing-2xl) 0 var(--spacing-lg);
    }

    .app-grid {
        grid-template-columns: 1fr;
        gap: var(--spacing-md);
    }

    .view-header {
        margin-bottom: var(--spacing-md);
    }

    .suggestion-card {
        padding: var(--spacing-md) var(--spacing-lg);
    }

    .form-actions {
        flex-direction: column-reverse;
        gap: var(--spacing-sm);
    }

    .form-actions .primary-btn,
    .form-actions .secondary-btn {
        width: 100%;
        padding: 12px;
    }

    .suggestion-footer {
        flex-direction: column;
        gap: var(--spacing-sm);
        align-items: stretch;
    }

    .vote-btn {
        width: 100%;
        padding: 12px;
        font-size: 0.9375rem;
    }

    .fab {
        width: 52px;
        height: 52px;
        bottom: calc(var(--spacing-lg) + env(safe-area-inset-bottom));
        right: var(--spacing-md);
    }

    .suggestions-list {
        padding-bottom: calc(72px + env(safe-area-inset-bottom));
    }

    .toast {
        top: var(--spacing-md);
        right: var(--spacing-md);
        left: var(--spacing-md);
        max-width: none;
    }

    .form-group input,
    .form-group textarea {
        padding: 12px;
        font-size: 1rem; /* Prevents iOS zoom on focus */
    }

    .filter-bar {
        margin-left: calc(-1 * var(--spacing-md));
        margin-right: calc(-1 * var(--spacing-md));
        padding: 4px var(--spacing-md);
    }

    /* Touch targets */
    button, .back-btn, .fab {
        min-height: 44px;
    }
}

/* Small Mobile */
@media (max-width: 480px) {
    .container {
        padding: var(--spacing);
    }

    .header {
        padding: var(--spacing-lg) 0 var(--spacing);
        margin-bottom: var(--spacing-xl);
    }

    .app-card {
        padding: var(--spacing-md);
    }

    .suggestion-card {
        padding: var(--spacing-md);
    }

    .fab {
        width: 48px;
        height: 48px;
        bottom: calc(var(--spacing-md) + env(safe-area-inset-bottom));
        right: var(--spacing);
    }

    .filter-bar {
        margin-left: calc(-1 * var(--spacing));
        margin-right: calc(-1 * var(--spacing));
        padding: 4px var(--spacing);
    }

    .overlay-content {
        padding: var(--spacing-lg);
    }

    /* Disable hover effects on touch */
    @media (hover: none) {
        .app-card:hover,
        .suggestion-card:hover {
            background: var(--surface);
            border-color: var(--border);
        }
    }
}
```

**Step 2: Commit**
```bash
git add public/style.css
git commit -m "feat: redesign mobile responsive layout with touch-optimized styles"
```

---

## Task 10: Admin-Seite Redesign

**Files:**
- Modify: `public/admin.html` (Inline-Styles im `<style>` Block)

**Step 1: Admin-Header von dunkel zu hell**

Ersetze den `.admin-header`-Style:

```css
.admin-header {
    text-align: center;
    margin-bottom: var(--spacing-3xl);
    padding: var(--spacing-3xl) 0 var(--spacing-xl);
    border-bottom: 1px solid var(--border);
}

.admin-header::before {
    display: none;
}

.admin-header h1 {
    font-family: var(--font-serif);
    font-size: clamp(2rem, 5vw, 3rem);
    font-weight: 700;
    color: var(--text-primary);
    margin-bottom: var(--spacing-sm);
    letter-spacing: -0.03em;
}

.admin-header p {
    color: var(--text-secondary);
    font-size: 1rem;
}
```

**Step 2: Stats-Cards**

```css
.stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--spacing-xl);
    text-align: center;
    transition: var(--transition);
}

.stat-card::before {
    display: none; /* Entferne den farbigen Top-Border */
}

.stat-card:hover {
    background: var(--bg-secondary);
    transform: none;
    box-shadow: none;
}

.stat-number {
    font-family: var(--font-serif);
    font-size: clamp(2rem, 5vw, 3rem);
    font-weight: 700;
    color: var(--text-primary);
    -webkit-text-fill-color: var(--text-primary);
    background: none;
    -webkit-background-clip: unset;
    background-clip: unset;
    display: block;
    margin-bottom: var(--spacing-xs);
    letter-spacing: -0.02em;
}

.stat-label {
    color: var(--text-secondary);
    font-size: 0.875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
}
```

**Step 3: Management-Sections**

```css
.management-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
}

.apps-list h3, .suggestions-list h3 {
    padding: var(--spacing-md) var(--spacing-lg);
    background: var(--bg-secondary);
    margin: 0;
    border-bottom: 1px solid var(--border);
    font-family: var(--font-serif);
    font-size: 1.125rem;
    font-weight: 600;
    letter-spacing: -0.01em;
}

.app-item, .suggestion-item {
    border-bottom: 1px solid var(--border-light);
}

.btn-danger {
    background: transparent;
    color: var(--danger-color);
    border: 1px solid var(--danger-color);
    border-radius: var(--radius);
    padding: 6px 12px;
    font-size: 0.8125rem;
    font-weight: 600;
    cursor: pointer;
    transition: var(--transition);
}

.btn-danger:hover {
    background: var(--danger-light);
}
```

**Step 4: Admin Mobile-Anpassungen**

```css
@media (max-width: 768px) {
    .admin-header {
        padding: var(--spacing-2xl) 0 var(--spacing-lg);
        margin-bottom: var(--spacing-xl);
    }

    .admin-actions {
        flex-direction: column;
    }

    .admin-actions .primary-btn,
    .admin-actions .secondary-btn {
        width: 100%;
    }

    .stats-grid {
        grid-template-columns: repeat(3, 1fr);
        gap: var(--spacing-sm);
    }

    .stat-card {
        padding: var(--spacing-md);
    }

    .stat-number {
        font-size: 1.5rem;
    }

    .stat-label {
        font-size: 0.75rem;
    }

    .app-item, .suggestion-item {
        flex-direction: column;
    }

    .suggestion-header {
        flex-direction: column;
    }
}

@media (max-width: 480px) {
    .admin-header {
        padding: var(--spacing-lg) 0 var(--spacing);
        margin-bottom: var(--spacing-lg);
    }

    .stats-grid {
        grid-template-columns: repeat(3, 1fr);
    }

    .stat-number {
        font-size: 1.25rem;
    }
}
```

**Step 5: Commit**
```bash
git add public/admin.html
git commit -m "feat: redesign admin dashboard to match Notion-style"
```

---

## Task 11: Legacy Variable Migration & Cleanup

**Files:**
- Modify: `public/style.css` (Search & Replace alte Variable-Referenzen)
- Modify: `public/index.html` (Inline-Style Variable-Referenzen)

**Step 1: Suche alle Referenzen zu alten CSS-Variables**

Folgende Mappings anwenden:

| Alt | Neu |
|---|---|
| `var(--primary-color)` | `var(--accent)` |
| `var(--primary-hover)` | `var(--accent-hover)` |
| `var(--primary-light)` | `var(--accent-light)` |
| `var(--background)` | `var(--bg)` |
| `var(--background-alt)` | `var(--bg-secondary)` |
| `var(--surface-elevated)` | `var(--surface)` |
| `var(--glass-bg)` | `var(--surface)` |
| `var(--border-focus)` | `var(--accent)` |
| `var(--gradient-primary)` | `var(--accent)` |
| `var(--gradient-accent)` | `var(--accent)` |
| `var(--shadow-xl)` | `var(--shadow-lg)` |
| `var(--text-primary)` (wo als primary button bg benutzt) | `var(--accent)` |

Prüfe auch alle Inline-Styles in `index.html` und `admin.html` auf veraltete Variablen.

**Step 2: Entferne nicht mehr benötigte Variablen aus `:root`**

Die folgenden Variablen wurden entfernt/umbenannt und dürfen nicht mehr existieren:
- `--primary-color`, `--primary-hover`, `--primary-light`
- `--accent-color`, `--accent-hover` (altes Amber)
- `--background`, `--background-alt`
- `--surface-elevated`, `--glass-bg`
- `--border-focus`
- `--gradient-primary`, `--gradient-accent`, `--gradient-surface`
- `--shadow-xl`

**Step 3: Commit**
```bash
git add public/style.css public/index.html public/admin.html
git commit -m "chore: migrate all CSS variables to new Notion-style tokens"
```

---

## Task 12: Visueller Smoke-Test

**Step 1: Starte den Dev-Server**

```bash
# Prüfe wie der Server gestartet wird
cat vercel.json  # oder package.json für Start-Script
```

**Step 2: Teste alle Views im Browser**

Checklist:
- [ ] Startseite: Header, App-Grid sichtbar
- [ ] App-Card hover funktioniert
- [ ] Suggestion-View: Cards, Filter-Bar, Vote-Buttons
- [ ] Suggestion-Form: Inputs, Labels, Buttons
- [ ] Settings-Modal öffnet/schließt
- [ ] Success-Overlay
- [ ] Toast-Benachrichtigungen
- [ ] Admin-Dashboard: Stats, Listen, Modals
- [ ] Mobile (320px Viewport): Alles lesbar und benutzbar
- [ ] Mobile (375px Viewport): Filter-Bar scrollbar
- [ ] Tablet (768px Viewport): Grid-Layout korrekt
- [ ] Keine Console-Errors bezüglich fehlender CSS-Variablen

**Step 3: Final Commit**
```bash
git add -A
git commit -m "feat: complete Notion-style UI redesign"
```
