const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');

test('login page lets existing users request and consume a magic login link', () => {
  const html = fs.readFileSync(path.join(rootDir, 'public/login.html'), 'utf8');
  const script = fs.readFileSync(path.join(rootDir, 'public/login.js'), 'utf8');

  assert.ok(html.includes('id="loginForm"'));
  assert.ok(html.includes('name="email"'));
  assert.ok(html.includes('href="/signup.html"'));
  assert.ok(html.includes('src="admin-auth.js"'));
  assert.ok(html.includes('src="login.js"'));
  assert.ok(script.includes("fetch('/api/auth/login-links'"));
  assert.ok(script.includes("fetch(`/api/auth/login-links/${encodeURIComponent(this.token)}/consume`"));
  assert.ok(script.includes('this.redirectUrl'));
  assert.ok(script.includes('redirectUrl: this.redirectUrl'));
  assert.ok(script.includes('window.adminAuth.setUserSession'));
  assert.equal(script.includes('data.loginUrl'), false);
  assert.equal(script.includes('Login-Link öffnen'), false);
  assert.ok(script.includes('Login-Link wurde per E-Mail verschickt.'));
});

test('login link API endpoints are exposed without global admin auth', () => {
  assert.ok(apiSource.includes("app.post('/api/auth/login-links'"));
  assert.ok(apiSource.includes("app.post('/api/auth/login-links/:token/consume'"));
  assert.ok(apiSource.includes("app.get('/api/auth/session'"));
  assert.ok(apiSource.includes('buildLoginLinkData'));
  assert.ok(apiSource.includes('resolvePendingLoginLinkByToken'));
  assert.ok(apiSource.includes('sendLoginLinkEmail'));
  assert.ok(apiSource.includes('loadActiveUserTenants'));
  assert.ok(apiSource.includes('redirectUrl: req.body?.redirectUrl'));
  assert.ok(apiSource.includes('loginLink.redirectUrl'));
  assert.equal(apiSource.includes('loginUrl,'), false);
});

test('login links prefer the current request host over configured base url', () => {
  const requestHostIndex = apiSource.indexOf("req.headers['x-forwarded-host']");
  const baseUrlIndex = apiSource.indexOf('process.env.BASE_URL', requestHostIndex);

  assert.ok(requestHostIndex > -1);
  assert.ok(baseUrlIndex > requestHostIndex);
});
