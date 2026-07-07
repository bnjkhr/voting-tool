const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');

// Die Board-SPA (index.html) wird via spa-fallback auch auf pfad-tiefen URLs
// ausgeliefert (/{tenant}/{board}). Relative Asset-Pfade (style.css) würden dort
// zu /{tenant}/style.css auflösen -> 404 -> ungestyltes, totes Board. Assets
// müssen daher root-relativ (/...) referenziert werden.

test('index.html referenziert CSS/JS root-relativ (nicht pfad-relativ)', () => {
  assert.ok(indexHtml.includes('href="/style.css"'), 'style.css muss /style.css sein');
  assert.ok(indexHtml.includes('src="/script.js"'), 'script.js muss /script.js sein');
  assert.ok(indexHtml.includes('src="/url-state.js"'), 'url-state.js muss /url-state.js sein');
});

test('keine pfad-relativen Asset-Referenzen mehr in index.html', () => {
  // href/src, die nicht mit / http #(anchor) data: mailto: beginnen (leeres
  // src="" für das dynamisch gesetzte Modal-Bild ist erlaubt).
  const refs = indexHtml.match(/(?:href|src)="([^"]*)"/g) || [];
  const relative = refs
    .map((r) => r.replace(/^(?:href|src)="/, '').replace(/"$/, ''))
    .filter((v) => v !== '' && !/^(\/|https?:|#|data:|mailto:)/.test(v));
  assert.deepEqual(relative, [], `pfad-relative Referenzen gefunden: ${relative.join(', ')}`);
});
