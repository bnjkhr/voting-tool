const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const tenantAdminHtml = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.html'), 'utf8');
const tenantAdminScript = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.js'), 'utf8');

// ---------------------------------------------------------------------------
// Backend: tenant-scoped release management
// ---------------------------------------------------------------------------

test('tenant admin exposes tenant-scoped release routes with role guards', () => {
  [
    "app.get('/api/admin/tenants/:tenantSlug/releases', requireTenantAccess()",
    "app.post('/api/admin/tenants/:tenantSlug/releases', requireTenantAccess(['owner', 'admin'])",
    "app.put('/api/admin/tenants/:tenantSlug/releases/:releaseId', requireTenantAccess(['owner', 'admin'])",
    "app.delete('/api/admin/tenants/:tenantSlug/releases/:releaseId', requireTenantAccess(['owner', 'admin'])",
    "app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/release', requireTenantAccess(['owner', 'admin'])",
  ].forEach(route => {
    assert.ok(apiSource.includes(route), `expected tenant-scoped release route: ${route}`);
  });
});

test('tenant release reads are scoped to the resolved tenant, not the legacy filter', () => {
  // The new console must never reuse the legacy isLegacyTenantData gate for
  // releases — that would either leak legacy releases into tenants or block
  // tenant releases entirely. It resolves and filters by the tenant id.
  assert.ok(
    apiSource.includes('loadReleasesForTenant(tenant.id'),
    'expected GET releases to load through a tenant-scoped loader',
  );
  assert.ok(
    /function loadReleasesForTenant\([^)]*tenantId/.test(apiSource),
    'expected a loadReleasesForTenant(tenantId, ...) helper',
  );
  assert.ok(
    apiSource.includes("db.collection('releases').where('tenantId', '==', tenantId)"),
    'expected the loader to query releases scoped to the tenant, not read the whole collection',
  );
});

test('tenant release create resolves publishedAt instead of leaking the serverTimestamp sentinel', () => {
  assert.ok(
    apiSource.includes("publishedAt: validStatus === 'veröffentlicht' ? new Date() : null"),
    'expected the create response to override publishedAt with a real date',
  );
});

test('tenant release delete unlinks suggestions in bounded batches', () => {
  assert.ok(
    apiSource.includes('RELEASE_UNLINK_BATCH_LIMIT'),
    'expected a batch-size limit so deletes survive Firestore’s 500-write cap',
  );
  assert.ok(
    /for \(let i = 0; i < scopedSuggestions\.length; i \+= RELEASE_UNLINK_BATCH_LIMIT\)/.test(apiSource),
    'expected the unlink updates to be committed in chunks',
  );
});

test('tenant release writes verify the release belongs to the tenant', () => {
  // Cross-tenant guard: a release id from tenant A must 404 for tenant B.
  const guard = 'getTenantId(releaseDoc.data() || {}) !== tenant.id';
  const occurrences = apiSource.split(guard).length - 1;
  assert.ok(
    occurrences >= 2,
    `expected the release ownership guard in PUT and DELETE handlers (found ${occurrences})`,
  );
});

test('tenant release creation verifies the target app belongs to the tenant', () => {
  assert.ok(
    apiSource.includes("getTenantId(appDoc.data() || {}) !== tenant.id"),
    'expected POST release to reject apps from other tenants',
  );
});

test('assigning a suggestion to a release stays within tenant scope', () => {
  // Reuses the trusted tenant-scoped suggestion resolver and checks the
  // release belongs to the same tenant before linking.
  assert.ok(
    apiSource.includes('resolveTenantSuggestionById(tenantSlug, suggestionId)'),
    'expected suggestion-release link to resolve the suggestion through tenant scope',
  );
});

test('legacy release endpoints remain untouched and password-gated', () => {
  // Production-critical: the legacy admin release endpoints stay on
  // requireAdminAuth + isLegacyTenantData and are not converted.
  [
    "app.get('/api/admin/releases', requireAdminAuth",
    "app.post('/api/admin/releases', requireAdminAuth",
    "app.put('/api/admin/releases/:releaseId', requireAdminAuth",
    "app.delete('/api/admin/releases/:releaseId', requireAdminAuth",
  ].forEach(route => {
    assert.ok(apiSource.includes(route), `expected legacy release route intact: ${route}`);
  });
});

test('public per-tenant release read endpoint still exists', () => {
  assert.ok(
    apiSource.includes("app.get('/api/tenants/:tenantSlug/apps/:appSlug/releases'"),
    'expected the public tenant release endpoint that feeds the roadmap/changelog',
  );
});

// ---------------------------------------------------------------------------
// UI: top-tab navigation
// ---------------------------------------------------------------------------

test('tenant admin uses top-tab navigation instead of one stacked sidebar', () => {
  assert.ok(tenantAdminHtml.includes('data-action="switch-view"'), 'expected tab buttons');
  ['entries', 'releases', 'boards', 'team', 'settings'].forEach(view => {
    assert.ok(
      tenantAdminHtml.includes(`data-view="${view}"`),
      `expected a view container/tab for "${view}"`,
    );
  });
  assert.ok(tenantAdminScript.includes('switchView'), 'expected a switchView method');
});

test('entries view is the default and keeps the entries list and filters', () => {
  assert.ok(tenantAdminHtml.includes('id="suggestionsList"'));
  assert.ok(tenantAdminHtml.includes('id="appFilter"'));
  assert.ok(tenantAdminHtml.includes('id="statusFilter"'));
});

// ---------------------------------------------------------------------------
// UI: release management surface
// ---------------------------------------------------------------------------

test('tenant admin renders a release management surface', () => {
  [
    'id="releaseForm"',
    'id="releasesList"',
    'name="releaseAppId"',
    'name="releaseVersion"',
    'name="releaseStatus"',
    'name="releaseDate"',
    'name="releaseDescription"',
  ].forEach(fragment => {
    assert.ok(tenantAdminHtml.includes(fragment), `expected release UI fragment: ${fragment}`);
  });

  ['geplant', 'in Arbeit', 'veröffentlicht'].forEach(status => {
    assert.ok(
      tenantAdminHtml.includes(`value="${status}"`),
      `expected release status option: ${status}`,
    );
  });
});

test('release UI talks to the tenant-scoped release routes', () => {
  ['loadReleases', 'renderReleases', 'saveRelease', 'deleteRelease'].forEach(method => {
    assert.ok(tenantAdminScript.includes(method), `expected release method: ${method}`);
  });
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath('/releases')"));
});

test('release controls use data-action delegation, not new inline handlers', () => {
  ['edit-release', 'delete-release'].forEach(action => {
    assert.ok(
      tenantAdminScript.includes(`data-action="${action}"`),
      `expected delegated release action: ${action}`,
    );
  });
  // The release select in entry cards is delegated as well.
  assert.ok(
    tenantAdminScript.includes('assign-release'),
    'expected release assignment wired via delegation',
  );
});
