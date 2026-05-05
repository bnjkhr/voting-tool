const { buildAppSlug, buildTenantSlug } = require('./tenant-utils');

const SAFE_TEST_TENANT_PREFIXES = ['test-', 'staging-'];
const DEFAULT_TEST_APP_SLUG = 'board';

function normalizeTestTenantSlug(value) {
  return buildTenantSlug(value);
}

function isSafeTestTenantSlug(slug) {
  const normalized = normalizeTestTenantSlug(slug);
  return SAFE_TEST_TENANT_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function assertSafeTestTenantSlug(slug) {
  const normalized = normalizeTestTenantSlug(slug);
  if (!isSafeTestTenantSlug(normalized)) {
    throw new Error(
      `Unsafe test tenant slug "${slug}". Use a slug starting with ${SAFE_TEST_TENANT_PREFIXES.join(' or ')}.`
    );
  }

  return normalized;
}

function buildDefaultTestTenantName(slug) {
  const normalized = assertSafeTestTenantSlug(slug);
  return `Test Tenant ${normalized}`;
}

function buildDefaultTestAppName(tenantSlug) {
  return `Smoke Board ${assertSafeTestTenantSlug(tenantSlug)}`;
}

function buildTestAppSlug(value) {
  return buildAppSlug(value || DEFAULT_TEST_APP_SLUG);
}

module.exports = {
  DEFAULT_TEST_APP_SLUG,
  SAFE_TEST_TENANT_PREFIXES,
  assertSafeTestTenantSlug,
  buildDefaultTestAppName,
  buildDefaultTestTenantName,
  buildTestAppSlug,
  isSafeTestTenantSlug,
  normalizeTestTenantSlug,
};
