const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');

test('super admin page loads the provisioning script and form fields', () => {
  const html = fs.readFileSync(path.join(rootDir, 'public/super-admin.html'), 'utf8');

  assert.ok(html.includes('platform-admin-shell'));
  assert.ok(html.includes('Platform Admin'));
  assert.ok(html.includes('src="admin-auth.js"'));
  assert.ok(html.includes('src="super-admin.js"'));
  assert.ok(html.includes('id="tenantProvisionForm"'));
  assert.ok(html.includes('id="tenantList"'));
  assert.ok(html.includes('id="refreshTenantsBtn"'));
  assert.ok(html.includes('name="tenantName"'));
  assert.ok(html.includes('name="tenantSlug"'));
  assert.ok(html.includes('name="appName"'));
  assert.ok(html.includes('name="ticketPrefix"'));
});

test('super admin provisioning posts to the admin tenant API with bearer auth', () => {
  const script = fs.readFileSync(path.join(rootDir, 'public/super-admin.js'), 'utf8');

  assert.ok(script.includes("window.adminAuth.authFetch('/api/admin/tenants'"));
  assert.ok(script.includes("method: 'POST'"));
});

test('super admin loads tenant list through the admin api', () => {
  const script = fs.readFileSync(path.join(rootDir, 'public/super-admin.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');

  assert.ok(apiSource.includes("app.get('/api/admin/tenants'"));
  assert.ok(script.includes("window.adminAuth.authFetch('/api/admin/tenants')"));
  assert.ok(script.includes('renderTenantList'));
  assert.ok(script.includes('tenant-admin.html?tenant='));
});

test('tenant admin links to super admin provisioning', () => {
  const html = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.html'), 'utf8');

  assert.ok(html.includes('id="platformAdminLink"'));
  assert.ok(html.includes('href="/super-admin.html"'));
});

test('super admin exposes a friendly pilot readiness panel', () => {
  const html = fs.readFileSync(path.join(rootDir, 'public/super-admin.html'), 'utf8');
  const script = fs.readFileSync(path.join(rootDir, 'public/super-admin.js'), 'utf8');
  const pilotRunbook = fs.readFileSync(path.join(rootDir, 'docs/pilot-readiness.md'), 'utf8');
  const smokeTestPlan = fs.readFileSync(path.join(rootDir, 'docs/pilot-smoke-test.md'), 'utf8');

  assert.ok(html.includes('id="pilot"'));
  assert.ok(html.includes('id="pilotTenantSlug"'));
  assert.ok(html.includes('id="pilotTenantStatus"'));
  assert.ok(html.includes('id="pilotPublicLink"'));
  assert.ok(html.includes('id="pilotAdminLink"'));
  assert.ok(html.includes('id="pilotLoginLink"'));
  assert.ok(html.includes('data-pilot-check'));
  assert.ok(html.includes('Owner'));
  assert.ok(html.includes('Admin'));
  assert.ok(html.includes('Viewer'));

  assert.ok(script.includes('updatePilotLinks'));
  assert.ok(script.includes('renderPilotStatus'));
  assert.ok(script.includes('loadPilotChecklist'));
  assert.ok(script.includes('savePilotChecklist'));
  assert.ok(script.includes('pilotTenantSlug'));
  assert.ok(script.includes('appCount'));

  assert.ok(pilotRunbook.includes('# Friendly User Pilot Readiness'));
  assert.ok(pilotRunbook.includes('Pilot-Tenant'));
  assert.ok(pilotRunbook.includes('Invite/Login'));
  assert.ok(pilotRunbook.includes('Rollback'));

  assert.ok(smokeTestPlan.includes('# Friendly User Pilot Smoke Test'));
  assert.ok(smokeTestPlan.includes('Tenant-Isolation'));
  assert.ok(smokeTestPlan.includes('Owner-Flow'));
  assert.ok(smokeTestPlan.includes('Abbruchkriterien'));
});
