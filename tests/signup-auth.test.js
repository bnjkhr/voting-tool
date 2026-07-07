const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const landingHtml = fs.readFileSync(path.join(rootDir, 'public/landing.html'), 'utf8');
const provisioning = require('../db/provisioning');
const { buildBoardDescription } = require('../api/tenant-provisioning');

// ---------------------------------------------------------------------------
// Signup + Magic-Link-Auth auf Postgres (hinter DATA_BACKEND)
// ---------------------------------------------------------------------------

test('Signup-/Auth-Endpoints existieren', () => {
  [
    "app.post('/api/signup/workspaces'",
    "app.post('/api/auth/login-links'",
    "app.post('/api/auth/login-links/:token/consume'",
    "app.get('/api/auth/session'",
    "app.post('/api/invites/:token/accept'",
    "app.get('/api/invites/:token'",
  ].forEach((route) => assert.ok(apiSource.includes(route), `erwartet Route: ${route}`));
});

test('Signup + Auth-Helfer haben einen Postgres-Branch', () => {
  // Provisionierung läuft über das gekapselte db-Modul (kein rohes SQL im Endpoint).
  assert.ok(apiSource.includes('repos.provisioning.provisionWorkspace('));
  assert.equal(/insert into (tenants|apps|memberships)/.test(apiSource), false, 'kein rohes SQL in api/index.js');
  // Die vier Auth-Helfer dispatchen auf Postgres.
  ['createUserSession', 'loadActiveUserTenants', 'resolvePendingInviteByToken', 'resolvePendingLoginLinkByToken']
    .forEach((fn) => {
      const idx = apiSource.indexOf(`function ${fn}(`);
      assert.ok(idx !== -1, `Helfer fehlt: ${fn}`);
      assert.ok(apiSource.slice(idx, idx + 1400).includes('usePostgres()'), `${fn} ohne Postgres-Branch`);
    });
});

test('LoginLink-Persistierung ist entdoppelt (ein Helfer, beide Endpoints)', () => {
  assert.ok(apiSource.includes('async function persistLoginLink('));
  const calls = apiSource.split('await persistLoginLink(loginLinkData)').length - 1;
  assert.ok(calls >= 2, `erwartet 2 Aufrufe von persistLoginLink (gefunden ${calls})`);
});

test('provisionWorkspace kapselt die atomare Provisionierung', () => {
  assert.equal(typeof provisioning.provisionWorkspace, 'function');
});

test('Signup überlebt einen fehlgeschlagenen Mailversand (kein 500)', () => {
  // Der Workspace ist schon committet; ein Mail-Fehler darf nicht in 500 kippen.
  assert.ok(apiSource.includes("const delivery = emailDelivered ? 'email' : 'failed';"),
    'erwartet ein delivery-Flag statt hartem Fehler');
  const idx = apiSource.indexOf('const signupLoginUrl =');
  const block = apiSource.slice(idx, idx + 600);
  assert.ok(/try\s*{[\s\S]*sendLoginLinkEmail[\s\S]*}\s*catch/.test(block),
    'der Signup-Mailversand muss in try/catch gekapselt sein');
});

test('buildBoardDescription ist die einzige Quelle des Board-Beschreibungstexts', () => {
  assert.equal(buildBoardDescription('Acme'), 'Feedback Board für Acme');
});

// ---------------------------------------------------------------------------
// Landing: CTAs scharfgeschaltet (kein "kommt-bald"-Gate mehr)
// ---------------------------------------------------------------------------

test('Landing-CTAs zeigen auf Signup/Login statt kommt-bald', () => {
  assert.equal(landingHtml.includes('kommt-bald'), false, 'kein kommt-bald-Link mehr auf der Landing');
  assert.ok(landingHtml.includes('href="/signup.html"'), 'erwartet Signup-CTA');
  assert.ok(landingHtml.includes('href="/login.html"'), 'erwartet Login-CTA');
});
