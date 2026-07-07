const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');

// Auf dem öffentlichen Board erscheint ein "Zur Konsole"-Link NUR, wenn eine
// gültige Session existiert und der Nutzer Owner/Admin genau dieses Workspaces
// ist. Same-origin (Session aus localStorage, Konsole auf gleicher Domain).

test('Konsolen-Link ist standardmäßig versteckt und session-gated', () => {
  assert.ok(/id="adminConsoleLink"[^>]*hidden/.test(html), 'Link existiert und ist per hidden versteckt');
  assert.ok(script.includes('checkConsoleAccess'), 'checkConsoleAccess-Methode vorhanden');
  assert.ok(script.includes("localStorage.getItem('userSessionToken')"), 'liest den Session-Token');
  assert.ok(script.includes("'/api/auth/session'"), 'prüft die Session serverseitig');
  assert.ok(script.includes("'x-user-session'"), 'sendet den Session-Header');
});

test('Link erscheint nur für owner/admin dieses Tenants und zeigt auf die Konsole', () => {
  // Ganzer Methodenkörper (großzügiges Fenster, damit spätere Zeilen nicht rausfallen).
  const idx = script.indexOf('async checkConsoleAccess(');
  const block = script.slice(idx, idx + 1400);
  assert.ok(block.includes('m.tenantSlug === tenantSlug'), 'nur passender Tenant');
  assert.ok(block.includes("m.role === 'owner'") && block.includes("m.role === 'admin'"), 'nur owner/admin');
  assert.ok(block.includes('/tenant-admin.html?tenant='), 'verlinkt die Tenant-Konsole');
  assert.ok(block.includes('encodeURIComponent(tenantSlug)'), 'Slug muss URL-encoded sein');
  assert.ok(block.includes('link.hidden = false'), 'blendet den Link ein');
  assert.ok(block.includes('link.hidden = true'), 'setzt den Link bei Tenant-Wechsel zurück');
});

test('Konsolen-Link wird bei jedem Tenant-Wechsel neu geprüft (nicht nur einmal)', () => {
  assert.ok(script.includes('nextTenantSlug !== this.consoleAccessTenant'),
    're-check pro Tenant, kein Einmal-Guard');
  // Veraltete async-Antwort nach zwischenzeitlichem Wechsel wird verworfen.
  assert.ok(script.includes('this.consoleAccessTenant !== tenantSlug'), 'stale-Ergebnis-Schutz');
});

test('Konsolen-Link ist gestylt und respektiert hidden', () => {
  assert.ok(css.includes('.console-link'), '.console-link-Styling vorhanden');
  assert.ok(css.includes('.console-link[hidden]'), 'hidden-Zustand explizit auf display:none');
});
