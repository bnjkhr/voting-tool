const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'public/script.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');

const UrlState = require('../public/url-state');

// Auf Workspace-Boards ist der "Zur Konsole"-Link für alle Besucher sichtbar und
// zeigt fest auf die Konsole (die Session liegt auf app.roadlight.pro und ist
// auf dem Board nicht lesbar). Legacy-Boards zeigen nichts Tenant-artiges.

test('Konsolen-Link ist standardmäßig versteckt und braucht keine Session-Prüfung', () => {
  assert.ok(/id="adminConsoleLink"[^>]*hidden/.test(html), 'Link existiert und ist per hidden versteckt');
  const idx = script.indexOf('checkConsoleAccess(tenantSlug)');
  const block = script.slice(idx, script.indexOf('applyUrlStateFromLocation(', idx));
  assert.ok(block.includes('UrlState.consoleLinkHref(window.location.hostname, tenantSlug)'));
  assert.ok(block.includes('link.hidden = !href'));
  assert.ok(!block.includes('fetch(') && !block.includes('localStorage'), 'keine Session-Prüfung mehr');
});

test('consoleLinkHref: Produktiv-Hosts absolut, sonst relativ, Legacy und ohne Slug versteckt', () => {
  const abs = 'https://app.roadlight.pro/tenant-admin.html?tenant=acme';
  assert.equal(UrlState.consoleLinkHref('roadlight.pro', 'acme'), abs);
  assert.equal(UrlState.consoleLinkHref('www.roadlight.pro', 'acme'), abs);
  assert.equal(UrlState.consoleLinkHref('RoadLight.pro', 'acme'), abs);
  const rel = '/tenant-admin.html?tenant=acme';
  for (const host of ['localhost', 'foo-git-x.vercel.app', 'app.roadlight.pro']) {
    assert.equal(UrlState.consoleLinkHref(host, 'acme'), rel, host);
  }
  assert.equal(UrlState.consoleLinkHref('votingtool.benkohler.de', 'acme'), null);
  assert.equal(UrlState.consoleLinkHref('roadlight.pro', null), null);
  assert.equal(UrlState.consoleLinkHref('roadlight.pro', ''), null);
  assert.equal(UrlState.consoleLinkHref('roadlight.pro', 'a b&c'), 'https://app.roadlight.pro/tenant-admin.html?tenant=a%20b%26c');
});

test('Konsolen-Link wird bei jedem Tenant-Wechsel neu gesetzt (nicht nur einmal)', () => {
  assert.ok(script.includes('nextTenantSlug !== this.consoleAccessTenant'),
    'pro Tenant neu setzen, kein Einmal-Guard');
});

test('Konsolen-Link ist gestylt und respektiert hidden', () => {
  assert.ok(css.includes('.console-link'), '.console-link-Styling vorhanden');
  assert.ok(css.includes('.console-link[hidden]'), 'hidden-Zustand explizit auf display:none');
});
