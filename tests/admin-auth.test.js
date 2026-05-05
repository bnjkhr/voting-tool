const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');

const adminAuthScriptPath = path.join(rootDir, 'public/admin-auth.js');
const tenantAdminHtml = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.html'), 'utf8');
const tenantAdminScript = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.js'), 'utf8');
const superAdminHtml = fs.readFileSync(path.join(rootDir, 'public/super-admin.html'), 'utf8');
const superAdminScript = fs.readFileSync(path.join(rootDir, 'public/super-admin.js'), 'utf8');

test('admin pages load shared auth before page-specific scripts', () => {
  assert.ok(tenantAdminHtml.includes('src="admin-auth.js"'));
  assert.ok(superAdminHtml.includes('src="admin-auth.js"'));
  assert.ok(tenantAdminHtml.indexOf('src="admin-auth.js"') < tenantAdminHtml.indexOf('src="tenant-admin.js"'));
  assert.ok(superAdminHtml.indexOf('src="admin-auth.js"') < superAdminHtml.indexOf('src="super-admin.js"'));
});

test('shared admin auth renders a login form and manages the stored token', () => {
  const authScript = fs.readFileSync(adminAuthScriptPath, 'utf8');

  assert.ok(authScript.includes('class AdminAuth'));
  assert.ok(authScript.includes("this.storageKey = 'adminToken'"));
  assert.ok(authScript.includes("this.userSessionKey = 'userSessionToken'"));
  assert.ok(authScript.includes('localStorage.getItem(this.storageKey)'));
  assert.ok(authScript.includes('localStorage.setItem(this.storageKey'));
  assert.ok(authScript.includes('localStorage.removeItem(this.storageKey)'));
  assert.ok(authScript.includes('setUserSession'));
  assert.ok(authScript.includes('X-User-Session'));
  assert.ok(authScript.includes('admin-auth-overlay'));
  assert.ok(authScript.includes('admin-auth-form'));
  assert.ok(authScript.includes('/login.html'));
});

test('admin pages no longer use browser prompt authentication', () => {
  assert.equal(tenantAdminScript.includes('prompt('), false);
  assert.equal(superAdminScript.includes('prompt('), false);
});

test('admin pages use the shared auth fetch helper', () => {
  assert.ok(tenantAdminScript.includes('window.adminAuth.authFetch'));
  assert.ok(superAdminScript.includes('window.adminAuth.authFetch'));
});

test('tenant admin starts with session login instead of the password prompt', () => {
  const authScript = fs.readFileSync(adminAuthScriptPath, 'utf8');

  assert.ok(authScript.includes('async requireTenantAuth'));
  assert.ok(authScript.includes('/login.html?redirect='));
  assert.ok(tenantAdminScript.includes('window.adminAuth.requireTenantAuth'));
  assert.equal(tenantAdminScript.includes('window.adminAuth.requireAuth().then'), false);
});

test('tenant admin prefers user sessions over the global admin password fallback', () => {
  const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
  const authScript = fs.readFileSync(adminAuthScriptPath, 'utf8');

  const requireAuthBody = authScript.slice(
    authScript.indexOf('async requireAuth()'),
    authScript.indexOf('showLogin(message')
  );
  assert.ok(
    requireAuthBody.indexOf('if (this.getUserSession())') < requireAuthBody.indexOf('if (this.getToken())'),
    'expected browser auth to prefer an existing user session over an admin token'
  );

  const sessionRoute = apiSource.slice(
    apiSource.indexOf("app.get('/api/auth/session'"),
    apiSource.indexOf('// Public invite: inspect a pending invite token')
  );
  assert.ok(
    sessionRoute.indexOf('const sessionAuth = await resolveSessionAuth(req);') < sessionRoute.indexOf('if (hasValidAdminPassword(req))'),
    'expected /api/auth/session to resolve user session before platform admin password'
  );

  const tenantAccess = apiSource.slice(
    apiSource.indexOf('function requireTenantAccess'),
    apiSource.indexOf('async function loadTenantApps')
  );
  assert.ok(
    tenantAccess.indexOf('const sessionAuth = await resolveSessionAuth(req);') < tenantAccess.indexOf('if (hasValidAdminPassword(req))'),
    'expected tenant admin routes to resolve user session before admin password fallback'
  );
});
