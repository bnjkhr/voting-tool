const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalLoginRedirect } = require('../lib/canonical-login-host');
const { SESSION_TTL_DAYS, buildSessionData } = require('../api/team-utils');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('roadlight.pro/login.html leitet auf die Konsole um, Query bleibt erhalten', () => {
  assert.equal(
    canonicalLoginRedirect({ host: 'roadlight.pro' }, '/login.html?token=abc&redirect=%2Fx'),
    'https://app.roadlight.pro/login.html?token=abc&redirect=%2Fx'
  );
  assert.equal(canonicalLoginRedirect({ host: 'roadlight.pro' }, '/login.html'), 'https://app.roadlight.pro/login.html');
  assert.equal(
    canonicalLoginRedirect({ 'x-forwarded-host': 'RoadLight.pro:443', host: 'foo.vercel.app' }, '/login.html?a=1'),
    'https://app.roadlight.pro/login.html?a=1'
  );
});

test('andere Hosts und Pfade werden nicht umgeleitet', () => {
  for (const host of ['app.roadlight.pro', 'www.roadlight.pro', 'votingtool.benkohler.de', 'localhost:3000', '']) {
    assert.equal(canonicalLoginRedirect({ host }, '/login.html?token=abc'), null, host);
  }
  assert.equal(canonicalLoginRedirect({ host: 'roadlight.pro' }, '/signup.html'), null);
  assert.equal(canonicalLoginRedirect({ host: 'roadlight.pro' }, '/'), null);
  assert.equal(canonicalLoginRedirect({}, '/login.html'), null);
});

test('Session-Laufzeit kommt aus einer gemeinsamen Konstante', () => {
  assert.equal(SESSION_TTL_DAYS, 30);
  const now = new Date('2026-01-01T00:00:00Z');
  const data = buildSessionData({ userId: 'u', token: 't', now });
  assert.equal(Math.round((data.expiresAt - now) / 86400e3), SESSION_TTL_DAYS);
});

test('Session-Prüfung verlängert den Ablauf (Postgres und Firestore)', () => {
  const repo = read('db/sessions.js');
  assert.match(repo, /async function touch\(id, ttlDays\)/);
  assert.match(repo, /expires_at = now\(\) \+ make_interval\(days => \$2::int\)/);

  const api = read('api/index.js');
  const resolver = api.slice(api.indexOf('async function resolveSessionAuth('));
  const body = resolver.slice(0, resolver.indexOf('\n}\n'));
  assert.ok(body.includes('repos.sessions.touch(session.id, SESSION_TTL_DAYS)'));
  assert.ok(/expiresAt: renewedExpiresAt/.test(body));
  // Verlängert wird erst nach der Ablauf-Prüfung.
  assert.ok(body.indexOf('isSessionExpired(session)') < body.indexOf('sessions.touch'));
});

test('login.js erkennt bestehende Sessions und löscht bei Fehlern nicht pauschal', () => {
  const login = read('public/login.js');
  assert.ok(login.includes('/api/auth/session'));
  assert.ok(login.includes("'X-User-Session'"));
  assert.ok(!login.includes('clearToken()'), 'nur den User-Token entfernen, nie das adminToken');
  assert.ok(login.includes("localStorage.removeItem('userSessionToken')"));
  // 401 entfernt den Token, jeder andere Fehler behält ihn.
  const resume = login.slice(login.indexOf('async resumeExistingSession'));
  assert.ok(resume.indexOf('response.status === 401') < resume.indexOf('dropUserSession()'));
  assert.equal(resume.split('dropUserSession()').length - 1, 1);
  assert.ok(login.includes('new FormGuard(this.form'));
});
