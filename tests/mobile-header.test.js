const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(rootDir, 'public', 'style.css'), 'utf8');
const script = fs.readFileSync(path.join(rootDir, 'public', 'script.js'), 'utf8');

test('mobile suggestions view uses an inline sticky topbar instead of a fixed overlay toolbar', () => {
    assert.ok(
        !html.includes('id="mobileToolbar"'),
        'expected the global mobile overlay toolbar to be removed'
    );

    assert.ok(
        html.includes('id="suggestionsTopbar"'),
        'expected a dedicated suggestions topbar container for mobile'
    );

    assert.ok(
        html.includes('id="suggestionsFilters"'),
        'expected a dedicated filter host outside the scrolling suggestion cards'
    );

    assert.ok(
        css.includes('.suggestions-topbar') && css.includes('position: sticky;'),
        'expected sticky topbar styles for the mobile suggestions header'
    );

    assert.ok(
        !css.includes('.mobile-toolbar {\n    display: none;\n    position: fixed;'),
        'expected the removed toolbar to no longer use fixed positioning'
    );

    assert.ok(
        script.includes("document.getElementById('suggestionsFilters')"),
        'expected filter rendering to target the dedicated sticky filter host'
    );

    assert.ok(
        script.includes("this.currentFilters = { status: 'all', type: 'all' }"),
        'expected the public app to track separate status and type filters'
    );

    assert.ok(
        script.includes("this.renderFilterGroup('status', 'Status'") &&
        script.includes("this.renderFilterGroup('type', 'Typ'"),
        'expected dedicated filter groups for status and type'
    );

    assert.ok(
        script.includes('Alle Typen'),
        'expected the public filter UI to expose a type filter entry'
    );

    assert.ok(
        css.includes('.filter-groups') && css.includes('.filter-group-label'),
        'expected dedicated styles for grouped filter controls'
    );

    assert.ok(
        html.includes('id="appHeader"'),
        'expected the main hero header to be addressable by id'
    );

    assert.ok(
        script.includes("document.getElementById('appHeader')"),
        'expected view switching logic to control hero header visibility'
    );

    assert.ok(
        css.includes('.header.hidden') || css.includes('.header.is-hidden'),
        'expected dedicated styles for hiding the hero header after app selection'
    );

    assert.ok(
        css.includes('@media (max-width: 768px)') &&
        css.includes('padding-top: calc(42px + var(--spacing-lg));') &&
        css.includes('.theme-toggle-btn {\n        top: var(--spacing-sm);\n        right: 0;'),
        'expected mobile header spacing that keeps the theme toggle out of the hero title'
    );
});
