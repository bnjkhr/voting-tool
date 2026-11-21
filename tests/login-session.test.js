const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalLoginRedirect } = require('../lib/canonical-login-host');
const { SESSION_TTL_DAYS, SESSION_MAX_AGE_DAYS, buildSessionData, isSafeRedirectPath } = require('../api/team-utils');

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
  assert.equal(
    canonicalLoginRedirect({ host: 'roadlight.pro' }, '/accept-invite.html?token=x'),
    'https://app.roadlight.pro/accept-invite.html?token=x'
  );
  assert.equal(
    canonicalLoginRedirect({ host: 'roadlight.pro' }, '/tenant-admin.html?tenant=a'),
    'https://app.roadlight.pro/tenant-admin.html?tenant=a'
  );
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
  assert.match(repo, /async function touch\(id, ttlDays, maxAgeDays\)/);
  assert.match(repo, /expires_at = least\(now\(\) \+ make_interval\(days => \$2::int\)/);

  const api = read('api/index.js');
  const resolver = api.slice(api.indexOf('async function resolveSessionAuth('));
  const body = resolver.slice(0, resolver.indexOf('\n}\n'));
  assert.ok(body.includes('repos.sessions.touch(session.id, SESSION_TTL_DAYS, SESSION_MAX_AGE_DAYS)'));
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

test('isSafeRedirectPath lehnt Tab/Newline/Backslash-Tricks ab', () => {
  for (const bad of ['/\t/evil.com', '/\n/evil.com', '/\\evil.com', '//evil.com', '/a b', 'https://evil.com']) {
    assert.equal(isSafeRedirectPath(bad), false, JSON.stringify(bad));
  }
  assert.equal(isSafeRedirectPath('/tenant-admin.html?tenant=x'), true);
});

test('Session hat eine absolute Obergrenze und Logout widerruft serverseitig', () => {
  assert.equal(SESSION_MAX_AGE_DAYS, 180);
  assert.match(read('db/sessions.js'), /least\(now\(\) \+ make_interval\(days => \$2::int\)/);
  const api = read('api/index.js');
  assert.ok(api.includes("app.post('/api/auth/logout'"));
  assert.ok(api.includes('repos.sessions.revoke(session.id)'));
  assert.ok(api.includes("res.setHeader('Cache-Control', 'no-store')"));
  assert.ok(read('public/admin-auth.js').includes("'/api/auth/logout'"));
  const login = read('public/login.js');
  assert.ok(login.includes('AbortSignal.timeout(5000)'));
  assert.ok(login.includes('history.replaceState'));
  assert.ok(login.includes('url.origin !== window.location.origin'));
});

test('Angemeldet ohne Workspace: Hinweis mit E-Mail (textContent), Link zur Registrierung, Formular bleibt', () => {
  const login = read('public/login.js');
  const html = read('public/login.html');
  const branch = login.slice(login.indexOf('Angemeldet, aber ohne Workspace'));
  assert.ok(branch.indexOf('showNoWorkspaceNotice(data.user?.email)') < branch.indexOf('this.showForm()'));
  const notice = login.slice(login.indexOf('showNoWorkspaceNotice(email) {'), login.indexOf('readUserSession() {'));
  assert.ok(notice.includes('this.sessionNoticeText.textContent'));
  assert.ok(!notice.includes('innerHTML'));
  assert.ok(notice.includes('gehörst aber noch zu keinem Workspace. '));
  assert.ok(notice.includes('Lass dich von einer Workspace-Inhaberin einladen oder leg einen eigenen Workspace an.'));
  assert.ok(/id="sessionNotice" hidden/.test(html));
  assert.ok(/<a href="\/signup\.html">Eigenen Workspace anlegen<\/a>/.test(html));
  assert.ok(html.indexOf('id="sessionNotice"') < html.indexOf('id="loginForm"'), 'Hinweis über dem Formular');
});
