const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEGACY_TENANT_ID,
  LEGACY_TENANT_SLUG,
  buildAppSlug,
  getTenantId,
  normalizeSlug,
  parseSlugParam,
} = require('../api/tenant-utils');

test('normalizeSlug turns names into url-safe identifiers', () => {
  assert.equal(normalizeSlug('  Family Manager  '), 'family-manager');
  assert.equal(normalizeSlug('Äpp Ümlaut'), 'app-umlaut');
});

test('buildAppSlug falls back to app when name is empty', () => {
  assert.equal(buildAppSlug(''), 'app');
});

test('getTenantId falls back to legacy for missing tenant metadata', () => {
  assert.equal(getTenantId({}), LEGACY_TENANT_ID);
  assert.equal(getTenantId({ tenantId: 'tenant-123' }), 'tenant-123');
});

test('parseSlugParam accepts only normalized route slugs', () => {
  assert.equal(parseSlugParam('staging-smoke'), 'staging-smoke');
  assert.equal(parseSlugParam(' STAGING-SMOKE '), 'staging-smoke');
  assert.equal(parseSlugParam('staging_smoke'), null);
  assert.equal(parseSlugParam(''), null);
});

test('legacy tenant constants stay stable', () => {
  assert.equal(LEGACY_TENANT_ID, 'legacy');
  assert.equal(LEGACY_TENANT_SLUG, 'legacy');
});
