const LEGACY_TENANT_ID = 'legacy';
const LEGACY_TENANT_SLUG = 'legacy';
const ACTIVE_TENANT_STATUS = 'active';

function normalizeSlug(value, { fallback = 'item', maxLength = 60 } = {}) {
  const source = typeof value === 'string' ? value : String(value || '');
  const normalized = source
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);

  return normalized || fallback;
}

function buildAppSlug(name) {
  return normalizeSlug(name, { fallback: 'app' });
}

function buildTenantSlug(name) {
  return normalizeSlug(name, { fallback: 'tenant' });
}

function parseSlugParam(value) {
  const source = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const normalized = normalizeSlug(source, { fallback: '' });
  return normalized && normalized === source ? normalized : null;
}

function getTenantId(data = {}) {
  const tenantId = typeof data.tenantId === 'string' ? data.tenantId.trim() : '';
  return tenantId || LEGACY_TENANT_ID;
}

function buildLegacyTenantData(timestampValue) {
  return {
    name: 'Legacy',
    displayName: 'Legacy Workspace',
    slug: LEGACY_TENANT_SLUG,
    status: ACTIVE_TENANT_STATUS,
    legacy: true,
    createdAt: timestampValue,
    updatedAt: timestampValue,
  };
}

module.exports = {
  ACTIVE_TENANT_STATUS,
  LEGACY_TENANT_ID,
  LEGACY_TENANT_SLUG,
  buildAppSlug,
  buildLegacyTenantData,
  buildTenantSlug,
  getTenantId,
  normalizeSlug,
  parseSlugParam,
};
