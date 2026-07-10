const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const tenantAdminHtml = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.html'), 'utf8');
const tenantAdminScript = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.js'), 'utf8');
const apiDocs = fs.readFileSync(path.join(rootDir, 'docs/api.md'), 'utf8');

test('v1 routes are mounted with API key middleware and the documented scopes', () => {
  const routes = [
    {
      signature: "app.get('/api/v1/me', requireApiKey(), rateLimitByApiKey(",
      note: '/me is reachable without any scope but still requires a valid key',
    },
    {
      signature:
        "app.get('/api/v1/apps', requireApiKey(['suggestions:read']), rateLimitByApiKey(",
      note: 'listing apps requires suggestions:read',
    },
    {
      signature:
        "app.get('/api/v1/apps/:appSlug/suggestions', requireApiKey(['suggestions:read']), rateLimitByApiKey(",
      note: 'listing suggestions requires suggestions:read',
    },
    {
      signature:
        "app.post('/api/v1/apps/:appSlug/suggestions', requireApiKey(['suggestions:write']), rateLimitByApiKey(",
      note: 'creating suggestions requires suggestions:write',
    },
    {
      signature:
        "app.get('/api/v1/suggestions/:suggestionId', requireApiKey(['suggestions:read']), rateLimitByApiKey(",
      note: 'fetching a single suggestion requires suggestions:read',
    },
    {
      signature:
        "app.patch('/api/v1/suggestions/:suggestionId', requireApiKey(['suggestions:status']), rateLimitByApiKey(",
      note: 'status/priority/labels updates require suggestions:status',
    },
    {
      signature:
        "app.get('/api/v1/suggestions/:suggestionId/comments', requireApiKey(['comments:read']), rateLimitByApiKey(",
      note: 'reading comments requires comments:read',
    },
    {
      signature:
        "app.post('/api/v1/suggestions/:suggestionId/comments', requireApiKey(['comments:write']), rateLimitByApiKey(",
      note: 'writing comments requires comments:write',
    },
  ];

  for (const { signature, note } of routes) {
    assert.ok(apiSource.includes(signature), `missing v1 route — ${note}: ${signature}`);
  }
});

test('requireApiKey looks tokens up by hash and rejects revoked keys', () => {
  assert.ok(
    apiSource.includes("parseApiKeyAuthHeader(req.headers.authorization)"),
    'token must be extracted via parseApiKeyAuthHeader, not parsed inline'
  );

  // The Firestore query must filter by hashed token, never by raw token.
  assert.ok(
    apiSource.includes(".where('tokenHash', '==', hashApiKeyToken(token))"),
    'token lookup must hash the incoming token before querying'
  );

  assert.equal(
    apiSource.includes(".where('token', '=="),
    false,
    'never query Firestore by the raw token'
  );

  assert.ok(
    apiSource.includes("'API key revoked'"),
    'revoked keys must produce a dedicated 401 response'
  );

  assert.ok(
    apiSource.includes('if (!isApiKeyActive(data))'),
    'revoked check must run before scope/tenant checks'
  );
});

test('requireApiKey enforces tenant + scope before any handler runs', () => {
  assert.ok(
    apiSource.includes('API key is missing required scope(s)'),
    'missing scopes must return a 403 with the required scope list'
  );

  assert.ok(
    apiSource.includes("await db.collection('tenants').doc(data.tenantId).get()"),
    'tenant must be resolved from the key, not from the URL'
  );

  assert.ok(
    apiSource.includes("'API key tenant inactive or missing'"),
    'inactive/missing tenants must be rejected before reaching the handler'
  );
});

test('loadApiKeySuggestionById prevents cross-tenant suggestion access', () => {
  assert.ok(
    apiSource.includes('async function loadApiKeySuggestionById'),
    'cross-tenant guard must live in a shared helper'
  );
  assert.ok(
    apiSource.includes('if (getTenantId(suggestionData) !== req.apiAuth.tenantId)'),
    'helper must compare suggestion tenant against the API key tenant'
  );
  // Same guard inlined for the suggestions list route.
  assert.ok(
    apiSource.includes('.filter(data => getTenantId(data) === req.apiAuth.tenantId)'),
    'suggestions list must filter by the API key tenant after the appId query'
  );
});

test('v1 writes are audited with an api:<keyId> actor and the active tenantId', () => {
  // POST /api/v1/apps/:appSlug/suggestions
  assert.ok(
    apiSource.includes("const actor = `api:${req.apiAuth.keyId}`;"),
    'writes must record actor as api:<keyId>'
  );
  assert.ok(
    apiSource.includes("tenantId: req.apiAuth.tenantId,"),
    'writes and activity entries must carry the resolved tenantId'
  );
  // PATCH status path produces structured activity entries.
  assert.ok(
    apiSource.includes("detail: `Status via API geändert: ${previousStatus || 'keiner'} → ${status}`"),
    'status changes must be auditable in German with explicit before/after values'
  );
  assert.ok(
    apiSource.includes("action: 'status_changed'"),
    'status changes must use the canonical status_changed action'
  );
});

test('v1 enforces a separate per-key rate limit window', () => {
  assert.ok(
    apiSource.includes('function rateLimitByApiKey('),
    'per-key rate limiter must be a dedicated middleware factory'
  );
  assert.ok(
    apiSource.includes("'API key rate limit exceeded. Please slow down.'"),
    'rate limit hit must respond with a key-specific 429 message'
  );

  // Documented limits from docs/api.md
  assert.ok(
    apiSource.includes('rateLimitByApiKey(60000, 120)'),
    'reads must use the 120/min limit documented in docs/api.md'
  );
  assert.ok(
    apiSource.includes('rateLimitByApiKey(60000, 30)'),
    'writes must use the 30/min limit documented in docs/api.md'
  );
});

test('tenant admin exposes scoped API key management to owners/admins', () => {
  [
    "app.get('/api/admin/tenants/:tenantSlug/api-keys', requireTenantAccess(['owner', 'admin'])",
    "app.post('/api/admin/tenants/:tenantSlug/api-keys', requireTenantAccess(['owner', 'admin']), rateLimit(",
    "app.delete('/api/admin/tenants/:tenantSlug/api-keys/:keyId', requireTenantAccess(['owner', 'admin'])",
  ].forEach(signature => {
    assert.ok(apiSource.includes(signature), `missing scoped api-keys route: ${signature}`);
  });

  // Listing must filter by tenant + sort newest first via buildApiKeyAdminResponse.
  assert.ok(apiSource.includes("db.collection('apiKeys')"));
  assert.ok(apiSource.includes(".where('tenantId', '==', tenant.id)"));
  assert.ok(apiSource.includes('buildApiKeyAdminResponse'));

  // Revoke must do a tenant-scoped membership check before flipping revokedAt.
  assert.ok(
    apiSource.includes("(keyDoc.data() || {}).tenantId !== tenant.id"),
    'revoke must reject keys that do not belong to the tenant from the URL slug'
  );
  assert.ok(
    apiSource.includes('revokedAt: admin.firestore.FieldValue.serverTimestamp()'),
    'revoke must use a server timestamp, not client time'
  );
});

test('tenant admin returns the raw token exactly once with reveal copy', () => {
  // Server only exposes the raw token on creation, alongside the safe response.
  const createBlock = apiSource.split("app.post('/api/admin/tenants/:tenantSlug/api-keys'")[1] || '';
  const revokeBlock = apiSource.split("app.delete('/api/admin/tenants/:tenantSlug/api-keys/:keyId'")[1] || '';
  const listBlock = apiSource
    .split("app.get('/api/admin/tenants/:tenantSlug/api-keys'")[1]
    ?.split("app.post('/api/admin/tenants/:tenantSlug/api-keys'")[0] || '';

  assert.ok(createBlock.includes('token,'), 'create response must include the raw token once');
  assert.ok(
    createBlock.includes("'Token wird nur einmal angezeigt. Bitte sicher aufbewahren.'"),
    'create response must warn that the token is only displayed once'
  );
  assert.equal(
    listBlock.includes('token,'),
    false,
    'list response must never echo the raw token field'
  );
  assert.equal(
    revokeBlock.includes('token,'),
    false,
    'revoke response must never echo the raw token field'
  );
});

test('tenant admin UI surfaces API keys with scope checkboxes and one-time reveal', () => {
  // HTML wiring
  assert.ok(tenantAdminHtml.includes('id="apiKeyForm"'));
  assert.ok(tenantAdminHtml.includes('id="apiKeysList"'));
  assert.ok(tenantAdminHtml.includes('id="apiKeyReveal"'));
  assert.ok(tenantAdminHtml.includes('name="apiKeyName"'));
  assert.ok(tenantAdminHtml.includes('name="apiKeyScope"'));
  ['suggestions:read', 'suggestions:write', 'suggestions:status', 'comments:read', 'comments:write']
    .forEach(scope => {
      assert.ok(
        tenantAdminHtml.includes(`value="${scope}"`),
        `tenant admin must expose a checkbox for ${scope}`
      );
    });

  // JS wiring
  assert.ok(tenantAdminScript.includes('loadApiKeys'));
  assert.ok(tenantAdminScript.includes('renderApiKeys'));
  assert.ok(tenantAdminScript.includes('createApiKey'));
  assert.ok(tenantAdminScript.includes('revokeApiKey'));
  assert.ok(tenantAdminScript.includes('revealApiKey'));
  assert.ok(tenantAdminScript.includes('copyApiKeyToClipboard'));
  assert.ok(
    tenantAdminScript.includes("this.tenantAdminPath('/api-keys')"),
    'API key management must go through the tenant-scoped admin path helper'
  );
  assert.ok(
    tenantAdminScript.includes("data-action=\"revoke-api-key\""),
    'revoke must be wired via data-action delegation, not inline handlers'
  );
  assert.ok(
    tenantAdminScript.includes("data-action=\"copy-api-key\""),
    'copy must be wired via data-action delegation, not inline handlers'
  );
  assert.ok(
    tenantAdminScript.includes("'API-Schlüssel widerrufen'"),
    'revoke confirmation toast must be in German with umlaut'
  );

  // Token must only appear in the reveal payload, never in the list rendering.
  // Anchor on the actual method definitions so we isolate just renderApiKeys's body.
  const listRender =
    tenantAdminScript.split('\n    renderApiKeys() {')[1]?.split('\n    async createApiKey()')[0] || '';
  assert.ok(listRender.length > 0, 'must find the renderApiKeys method body');
  assert.equal(
    /\bkey\.token\b(?!Prefix)/.test(listRender),
    false,
    'renderApiKeys must never reference key.token — only the safe tokenPrefix'
  );
  assert.ok(
    listRender.includes('key.tokenPrefix'),
    'renderApiKeys must show the safe tokenPrefix for active keys'
  );
});

test('docs/api.md documents every v1 endpoint, scope and rate limit', () => {
  // Endpoints
  [
    'GET /me',
    'GET /apps',
    'GET /apps/:appSlug/suggestions',
    'POST /apps/:appSlug/suggestions',
    'GET /suggestions/:id',
    'PATCH /suggestions/:id',
    'GET /suggestions/:id/comments',
    'POST /suggestions/:id/comments',
  ].forEach(fragment => {
    assert.ok(apiDocs.includes(fragment), `docs/api.md must document ${fragment}`);
  });

  // Scopes
  ['suggestions:read', 'suggestions:write', 'suggestions:status', 'comments:read', 'comments:write']
    .forEach(scope => {
      assert.ok(apiDocs.includes(scope), `docs/api.md must document the ${scope} scope`);
    });

  // Rate limits and base URL
  assert.ok(apiDocs.includes('120 Requests/Minute'));
  assert.ok(apiDocs.includes('30 Requests/Minute'));
  assert.ok(apiDocs.includes('https://votingtool.benkohler.de/api/v1'));
  assert.ok(apiDocs.includes('Authorization: Bearer vt_live_'));
});

// ---------------------------------------------------------------------------
// Pro-Gating: API-Schlüssel & MCP sind ein Pro-Feature
// ---------------------------------------------------------------------------

test('apiAccessRequiresUpgrade delegiert an das feature-unabhängige Gate in lib/billing', () => {
  assert.ok(apiSource.includes('function apiAccessRequiresUpgrade(tenant) {'), 'apiAccessRequiresUpgrade muss existieren');
  // Die 3-Bedingungs-Logik (enforced + stripe + postgres) lebt in lib/billing;
  // hier wird nur der usePostgres-Flag reingereicht. Verhalten deckt
  // tests/billing.test.js ab.
  assert.ok(
    apiSource.includes('return billing.requiresProUpgrade(tenant, { postgres: usePostgres() });'),
    'nutzt billing.requiresProUpgrade mit dem usePostgres-Flag als Plan-Quelle'
  );
});

test('API-Key-Erstellung ist hinter Pro gegated (402 upgrade_required)', () => {
  const createHandler = apiSource
    .split("app.post('/api/admin/tenants/:tenantSlug/api-keys'")[1]
    ?.split('app.delete')[0] || '';
  assert.ok(createHandler.length > 0, 'Create-Handler muss gefunden werden');
  assert.ok(createHandler.includes('apiAccessRequiresUpgrade(tenant)'), 'Create prüft das Entitlement');
  assert.ok(createHandler.includes("code: 'upgrade_required'"), 'liefert maschinenlesbaren Code');
  assert.ok(/res\.status\(402\)/.test(createHandler), 'gated mit 402 Payment Required');
});

test('requireApiKey sperrt die Nutzung bei Nicht-Pro (bestehende Keys, Downgrade)', () => {
  const middleware = apiSource
    .split('function requireApiKey(')[1]
    ?.split('async function loadApiKeySuggestionById')[0] || '';
  assert.ok(middleware.length > 0, 'requireApiKey muss gefunden werden');
  assert.ok(middleware.includes('apiAccessRequiresUpgrade(tenant)'), 'Usage-Gate im Middleware-Pfad');
  assert.ok(/res\.status\(402\)/.test(middleware), 'gated Requests liefern 402');
});

test('Tenant-Admin-UI sperrt die Key-Erstellung im Free-Plan', () => {
  assert.ok(tenantAdminScript.includes('isApiAccessGated()'), 'Frontend-Gate-Helper existiert');
  assert.ok(
    /this\.billing\.billingEnforced\) && !this\.isProPlan\(this\.billing\)/.test(tenantAdminScript),
    'Gate greift erst bei live Premium (billingEnforced) und Nicht-Pro'
  );
  assert.ok(tenantAdminScript.includes("this.isApiAccessGated()"), 'createApiKey nutzt den Gate-Check');
  assert.ok(tenantAdminHtml.includes('id="apiKeyProNotice"'), 'Pro-Hinweis-Element im Markup');
});

test('docs/api.md und api-docs.html weisen API/MCP als Pro-Feature aus', () => {
  assert.ok(/Pro-Feature/.test(apiDocs), 'docs/api.md nennt das Pro-Feature');
  assert.ok(apiDocs.includes('upgrade_required'), 'docs/api.md dokumentiert den 402-Code');
});

test('/billing meldet den Enforce-Status an die UI (Master-Schalter)', () => {
  const handler = apiSource
    .split("app.get('/api/admin/tenants/:tenantSlug/billing'")[1]
    ?.split('app.post')[0] || '';
  assert.ok(handler.includes('billingEnforced: billing.billingEnforced()'),
    '/billing gibt billingEnforced zurück, damit die UI vor dem Live-Schalten offen bleibt');
});
