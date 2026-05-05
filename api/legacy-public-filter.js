'use strict';

const LEGACY_TENANT_ID = 'legacy';

// Apps that historically lived on the legacy public board but must no longer
// surface there (e.g. tenant boards that were once seeded with legacy data).
// Defense-in-depth on top of the tenantId check.
const LEGACY_PUBLIC_HIDDEN_APP_IDS = new Set([
  'kjQEs8UlVd0OaMWrdHRd',
  'YfVxmtIVlVIMk3LfBPC8',
]);

function isLegacyPublicAppVisible(data = {}) {
  const tenantId = data.tenantId || LEGACY_TENANT_ID;
  if (tenantId !== LEGACY_TENANT_ID) return false;
  if (data.id && LEGACY_PUBLIC_HIDDEN_APP_IDS.has(data.id)) return false;
  if (data.hidden === true) return false;
  if (data.publicHidden === true) return false;
  if (data.isTestData === true) return false;
  return true;
}

module.exports = {
  LEGACY_TENANT_ID,
  LEGACY_PUBLIC_HIDDEN_APP_IDS,
  isLegacyPublicAppVisible,
};
