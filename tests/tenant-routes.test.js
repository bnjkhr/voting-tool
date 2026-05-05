const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiSource = fs.readFileSync(path.join(__dirname, '../api/index.js'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');

test('tenant read routes are additive and slug based', () => {
  [
    "app.get('/api/tenants/:tenantSlug'",
    "app.get('/api/tenants/:tenantSlug/apps'",
    "app.get('/api/tenants/:tenantSlug/apps/:appSlug'",
    "app.get('/api/tenants/:tenantSlug/apps/:appSlug/suggestions'",
    "app.get('/api/tenants/:tenantSlug/apps/:appSlug/releases'",
    "app.get('/api/tenants/:tenantSlug/suggestions/:suggestionId/comments'",
  ].forEach(route => {
    assert.ok(apiSource.includes(route), `expected ${route}`);
  });
});

test('tenant write routes are additive and scoped by slug', () => {
  [
    "app.post('/api/tenants/:tenantSlug/apps/:appSlug/suggestions'",
    "app.post('/api/tenants/:tenantSlug/suggestions/:suggestionId/vote'",
    "app.delete('/api/tenants/:tenantSlug/suggestions/:suggestionId/vote'",
    "app.get('/api/tenants/:tenantSlug/suggestions/:suggestionId/voted'",
    "app.post('/api/tenants/:tenantSlug/suggestions/:suggestionId/comments'",
  ].forEach(route => {
    assert.ok(apiSource.includes(route), `expected ${route}`);
  });
});

test('tenant write routes reject cross-tenant suggestions', () => {
  assert.ok(
    apiSource.includes('resolveTenantSuggestionById'),
    'expected tenant write routes to resolve suggestions through tenant scope'
  );

  assert.ok(
    apiSource.includes("getTenantId(suggestionData) !== tenant.id"),
    'expected tenant suggestion resolution to reject different tenant ids'
  );
});

test('README documents legacy and tenant public surfaces separately', () => {
  assert.ok(readme.includes('Legacy-kompatibel'));
  assert.ok(readme.includes('Additive SaaS-Public-Pfade'));
});

test('legacy public app routes hide known test apps', () => {
  assert.ok(apiSource.includes("require('./legacy-public-filter')"));
  assert.ok(apiSource.includes('LEGACY_PUBLIC_HIDDEN_APP_IDS'));
  assert.ok(apiSource.includes('isLegacyPublicAppVisible'));
  assert.ok(apiSource.includes('.filter(appData => isLegacyPublicAppVisible(appData))'));
  assert.ok(apiSource.includes('!isLegacyPublicAppVisible({ id: appId, ...appDoc.data() })'));
});
