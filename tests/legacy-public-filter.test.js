'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LEGACY_TENANT_ID,
  LEGACY_PUBLIC_HIDDEN_APP_IDS,
  isLegacyPublicAppVisible,
} = require('../api/legacy-public-filter');

// Production guard: the public board at votingtool.benkohler.de must only ever
// expose legacy-tenant apps. Any regression here leaks tenant boards (mbc,
// mitko, ben-s-testspace, staging-saas-smoke, …) onto the live home page.
// If you change this filter, also update the live verification step in docs.

test('legacy public filter accepts legacy apps without bad flags', () => {
  assert.equal(
    isLegacyPublicAppVisible({ id: 'fam', name: 'FamilyManager', tenantId: LEGACY_TENANT_ID }),
    true,
  );
});

test('legacy public filter treats missing tenantId as legacy (back-compat)', () => {
  assert.equal(
    isLegacyPublicAppVisible({ id: 'old-app', name: 'Pre-tenancy app' }),
    true,
  );
});

test('legacy public filter rejects non-legacy tenants', () => {
  for (const tenantId of ['mbc', 'mitko', 'ben-s-testspace', 'staging-saas-smoke', 'acme']) {
    assert.equal(
      isLegacyPublicAppVisible({ id: 'x', name: 'Tenant board', tenantId }),
      false,
      `tenantId=${tenantId} must not appear on legacy public board`,
    );
  }
});

test('legacy public filter rejects test data', () => {
  assert.equal(
    isLegacyPublicAppVisible({ id: 'tb', name: 'Smoke', tenantId: LEGACY_TENANT_ID, isTestData: true }),
    false,
  );
});

test('legacy public filter respects hidden / publicHidden flags', () => {
  assert.equal(
    isLegacyPublicAppVisible({ id: 'h', name: 'Hidden', tenantId: LEGACY_TENANT_ID, hidden: true }),
    false,
  );
  assert.equal(
    isLegacyPublicAppVisible({ id: 'h2', name: 'Hidden public', tenantId: LEGACY_TENANT_ID, publicHidden: true }),
    false,
  );
});

test('legacy public filter rejects ids on the deny list', () => {
  for (const id of LEGACY_PUBLIC_HIDDEN_APP_IDS) {
    assert.equal(
      isLegacyPublicAppVisible({ id, name: 'Blacklisted legacy app', tenantId: LEGACY_TENANT_ID }),
      false,
      `id=${id} must remain hidden even when tagged as legacy`,
    );
  }
});
