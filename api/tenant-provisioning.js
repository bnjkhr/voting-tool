const {
  ACTIVE_TENANT_STATUS,
  LEGACY_TENANT_ID,
  buildAppSlug,
  buildTenantSlug,
  parseSlugParam,
} = require('./tenant-utils');

function cleanName(value, fallback) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return normalized || fallback;
}

function buildTicketPrefix(value, fallbackSource = '') {
  const explicit = typeof value === 'string'
    ? value.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5)
    : '';

  if (explicit) return explicit;

  return fallbackSource.replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 3) || 'APP';
}

function resolveTenantSlug({ tenantSlug, tenantName }) {
  const explicitSlug = typeof tenantSlug === 'string' ? tenantSlug.trim() : '';
  if (explicitSlug) {
    const parsed = parseSlugParam(explicitSlug);
    if (!parsed) {
      throw new Error(`Invalid normalized tenant slug "${tenantSlug}". Use lowercase letters, numbers and hyphens.`);
    }
    return parsed;
  }

  return buildTenantSlug(tenantName);
}

function buildTenantProvisionConfig(options = {}) {
  const tenantName = cleanName(options.tenantName || options.name, 'New Tenant');
  const tenantSlug = resolveTenantSlug({ tenantSlug: options.tenantSlug, tenantName });

  if (tenantSlug === LEGACY_TENANT_ID) {
    throw new Error('The legacy tenant cannot be provisioned through SaaS provisioning.');
  }

  const appName = cleanName(options.appName, `${tenantName} Board`);
  const appSlug = options.appSlug
    ? parseSlugParam(String(options.appSlug))
    : buildAppSlug(appName);

  if (!appSlug) {
    throw new Error(`Invalid normalized app slug "${options.appSlug}". Use lowercase letters, numbers and hyphens.`);
  }

  const ticketPrefix = buildTicketPrefix(options.ticketPrefix, appName);

  return {
    tenantId: tenantSlug,
    tenantSlug,
    tenantName,
    appName,
    appSlug,
    ticketPrefix,
  };
}

function buildBoardDescription(tenantName) {
  return `Feedback Board für ${tenantName}`;
}

function buildTenantProvisionDocuments(config, timestampValue) {
  return {
    tenant: {
      name: config.tenantName,
      displayName: config.tenantName,
      slug: config.tenantSlug,
      status: ACTIVE_TENANT_STATUS,
      legacy: false,
      createdAt: timestampValue,
      updatedAt: timestampValue,
    },
    app: {
      tenantId: config.tenantId,
      name: config.appName,
      description: buildBoardDescription(config.tenantName),
      slug: config.appSlug,
      ticketPrefix: config.ticketPrefix,
      labels: [],
      createdAt: timestampValue,
      updatedAt: timestampValue,
    },
    counter: {
      tenantId: config.tenantId,
      prefix: config.ticketPrefix,
      nextNumber: 1,
      updatedAt: timestampValue,
    },
  };
}

module.exports = {
  buildTenantProvisionConfig,
  buildTenantProvisionDocuments,
  buildBoardDescription,
  buildTicketPrefix,
};
