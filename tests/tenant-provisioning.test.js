const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildTenantProvisionConfig,
  buildTenantProvisionDocuments,
} = require('../api/tenant-provisioning');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

test('tenant provisioning normalizes slugs and defaults the first board', () => {
  const config = buildTenantProvisionConfig({
    tenantName: 'Acme GmbH',
    appName: 'Feedback Portal',
  });

  assert.equal(config.tenantId, 'acme-gmbh');
  assert.equal(config.tenantSlug, 'acme-gmbh');
  assert.equal(config.tenantName, 'Acme GmbH');
  assert.equal(config.appSlug, 'feedback-portal');
  assert.equal(config.ticketPrefix, 'FEE');
});

test('tenant provisioning rejects legacy and malformed tenant slugs', () => {
  assert.throws(
    () => buildTenantProvisionConfig({ tenantSlug: 'legacy', tenantName: 'Legacy' }),
    /legacy tenant cannot be provisioned/
  );

  assert.throws(
    () => buildTenantProvisionConfig({ tenantSlug: 'Bad Slug', tenantName: 'Bad Slug' }),
    /normalized tenant slug/
  );
});

test('tenant provisioning documents include tenant scope and default app data', () => {
  const config = buildTenantProvisionConfig({
    tenantSlug: 'acme',
    tenantName: 'Acme',
    appName: 'Feedback Board',
    ticketPrefix: 'AC',
  });
  const docs = buildTenantProvisionDocuments(config, '<timestamp>');

  assert.deepEqual(docs.tenant, {
    name: 'Acme',
    displayName: 'Acme',
    slug: 'acme',
    status: 'active',
    legacy: false,
    createdAt: '<timestamp>',
    updatedAt: '<timestamp>',
  });

  assert.equal(docs.app.tenantId, 'acme');
  assert.equal(docs.app.slug, 'feedback-board');
  assert.equal(docs.app.ticketPrefix, 'AC');
  assert.deepEqual(docs.app.labels, []);
  assert.equal(docs.counter.tenantId, 'acme');
  assert.equal(docs.counter.prefix, 'AC');
  assert.equal(docs.counter.nextNumber, 1);
});

test('tenant provisioning is exposed through admin api and script', () => {
  assert.ok(
    apiSource.includes("app.post('/api/admin/tenants'"),
    'expected admin tenant provisioning route'
  );

  assert.equal(packageJson.scripts['tenant:create'], 'node scripts/create-tenant.js');
  assert.equal(packageJson.scripts['tenant:create:dry-run'], 'node scripts/create-tenant.js --dry-run');
});
