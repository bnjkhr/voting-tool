const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public/tenant-admin.js'), 'utf8');

// Öffentliche Boards sind pfad-basiert (/{tenant}/{board}); das alte
// Query-Format /?tenant=X&app=Y landet auf Root -> Landingpage.

test('tenant-admin baut Board-Links pfad-basiert, nicht als /?tenant=&app=', () => {
  assert.equal(/`\/\?tenant=\$\{[^`]*&app=/.test(adminJs), false,
    'kein /?tenant=...&app=... Board-Link mehr');
  assert.ok(adminJs.includes('boardUrl(tenantSlug, appSlug)'), 'erwartet einen boardUrl-Helfer');
  // Pfad-basiert: /{tenant}/{board}
  assert.ok(adminJs.includes('/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(appSlug)}'));
});

test('Board-URL zeigt auf die Hauptdomain (app.-Präfix entfällt)', () => {
  assert.ok(adminJs.includes("window.location.host.replace(/^app\\./, '')"),
    'die Konsole läuft auf app.roadlight.pro; Boards liegen auf roadlight.pro');
});
