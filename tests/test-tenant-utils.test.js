const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_TEST_APP_SLUG,
  assertSafeTestTenantSlug,
  buildDefaultTestAppName,
  buildDefaultTestTenantName,
  buildTestAppSlug,
  isSafeTestTenantSlug,
  normalizeTestTenantSlug,
} = require('../api/test-tenant-utils');

test('normalizeTestTenantSlug creates stable slugs', () => {
  assert.equal(normalizeTestTenantSlug('Staging Smoke'), 'staging-smoke');
});

test('safe test tenant slugs must use staging or test prefix', () => {
  assert.equal(isSafeTestTenantSlug('staging-smoke'), true);
  assert.equal(isSafeTestTenantSlug('test-smoke'), true);
  assert.equal(isSafeTestTenantSlug('customer-a'), false);
});

test('assertSafeTestTenantSlug rejects unsafe slugs', () => {
  assert.throws(() => assertSafeTestTenantSlug('production-customer'), /Unsafe test tenant slug/);
  assert.equal(assertSafeTestTenantSlug('staging-customer'), 'staging-customer');
});

test('default names are derived from the safe tenant slug', () => {
  assert.equal(buildDefaultTestTenantName('test-alpha'), 'Test Tenant test-alpha');
  assert.equal(buildDefaultTestAppName('test-alpha'), 'Smoke Board test-alpha');
});

test('test app slug builder uses board fallback', () => {
  assert.equal(buildTestAppSlug(''), DEFAULT_TEST_APP_SLUG);
  assert.equal(buildTestAppSlug('QA Board'), 'qa-board');
});
