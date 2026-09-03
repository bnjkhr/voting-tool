const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sourceSlice = require('./source-slice');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const tenantAdminHtml = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.html'), 'utf8');
const tenantAdminScript = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.js'), 'utf8');
const apiDocs = fs.readFileSync(path.join(rootDir, 'docs/api.md'), 'utf8');
const apiDocsHtml = fs.readFileSync(path.join(rootDir, 'public/api-docs.html'), 'utf8');

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
    {
      signature:
        "app.post('/api/v1/apps', requireApiKey(['boards:write']), rateLimitByApiKey(60000, 30)",
      note: 'creating a board requires boards:write, 30/min',
    },
    {
      signature:
        "app.patch('/api/v1/apps/:appSlug', requireApiKey(['boards:write']), rateLimitByApiKey(60000, 60)",
      note: 'renaming a board requires boards:write, 60/min',
    },
    {
      signature:
        "app.get('/api/v1/apps/:appSlug/releases', requireApiKey(['releases:read']), rateLimitByApiKey(60000, 120)",
      note: 'listing releases requires releases:read, 120/min',
    },
    {
      signature:
        "app.post('/api/v1/apps/:appSlug/releases', requireApiKey(['releases:write']), rateLimitByApiKey(60000, 30)",
      note: 'creating a release requires releases:write, 30/min',
    },
    {
      signature:
        "app.patch('/api/v1/releases/:releaseId', requireApiKey(['releases:write']), rateLimitByApiKey(60000, 60)",
      note: 'updating a release requires releases:write, 60/min',
    },
    {
      signature:
        "app.delete('/api/v1/releases/:releaseId', requireApiKey(['releases:write']), rateLimitByApiKey(60000, 30)",
      note: 'deleting a release requires releases:write, 30/min',
    },
    {
      signature:
        "app.put('/api/v1/suggestions/:suggestionId/release', requireApiKey(['releases:write']), rateLimitByApiKey(60000, 60)",
      note: 'assigning an entry to a release requires releases:write, 60/min',
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

  // Board- und Release-Verwaltung
  [
    'POST /apps',
    'PATCH /apps/:appSlug',
    'GET /apps/:appSlug/releases',
    'POST /apps/:appSlug/releases',
    'PATCH /releases/:releaseId',
    'DELETE /releases/:releaseId',
    'PUT /suggestions/:id/release',
  ].forEach(fragment => {
    assert.ok(apiDocs.includes(fragment), `docs/api.md must document ${fragment}`);
  });

  // Scopes
  [
    'suggestions:read', 'suggestions:write', 'suggestions:status',
    'comments:read', 'comments:write',
    'boards:write', 'releases:read', 'releases:write',
  ].forEach(scope => {
      assert.ok(apiDocs.includes(scope), `docs/api.md must document the ${scope} scope`);
    });

  // Rate limits and base URL
  assert.ok(apiDocs.includes('120 Requests/Minute'));
  assert.ok(apiDocs.includes('30 Requests/Minute'));
  assert.ok(apiDocs.includes('https://roadlight.pro/api/v1'));
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
  assert.ok(middleware.includes('requiresProUpgradeResolved(planTenant'),
    'Usage-Gate läuft über den fail-open-Wrapper requiresProUpgradeResolved');
  assert.ok(/res\.status\(402\)/.test(middleware), 'gated Requests liefern 402');
});

test('Tenant-Admin-UI sperrt die Key-Erstellung im Free-Plan', () => {
  assert.ok(tenantAdminScript.includes('isApiAccessGated()'), 'Frontend-Gate-Helper existiert');
  // Frontend-Gate spiegelt das Backend: billingEnforced UND billingEnabled (Postgres
  // implizit, da /billing ohne Postgres 404 liefert), und nur bei Nicht-Pro.
  assert.ok(
    /b\.billingEnforced && b\.billingEnabled\) && !this\.isProPlan\(b\)/.test(tenantAdminScript),
    'Gate greift erst bei live Premium (billingEnforced + billingEnabled) und Nicht-Pro'
  );
  assert.ok(tenantAdminScript.includes("this.isApiAccessGated()"), 'createApiKey nutzt den Gate-Check');
  // Das Formular bleibt für Nicht-Admins verborgen (Admin-only-Sichtbarkeit nicht überschreiben).
  assert.ok(
    /gated \|\| !this\.canManageWorkspace\(\)/.test(tenantAdminScript),
    'renderApiKeys erhält die Admin-only-Sichtbarkeit des Formulars'
  );
  assert.ok(tenantAdminHtml.includes('id="apiKeyProNotice"'), 'Pro-Hinweis-Element im Markup');
});

test('requireApiKey liest den Plan aus der Postgres-Plan-Quelle (nicht Firestore)', () => {
  const middleware = apiSource
    .split('function requireApiKey(')[1]
    ?.split('async function loadApiKeySuggestionById')[0] || '';
  assert.ok(middleware.length > 0, 'requireApiKey muss gefunden werden');
  // Nur wenn Gating live ist, den maßgeblichen Tenant (mit `plan`) aus Postgres holen.
  assert.ok(
    middleware.includes('billing.proGatingActive({ postgres: usePostgres() })'),
    'lädt den Plan-Tenant nur bei live Gating'
  );
  assert.ok(
    middleware.includes('repos.tenants.findById(data.tenantId)'),
    'Plan stammt aus der Postgres-Plan-Quelle, nicht aus dem Firestore-Tenant'
  );
  // Fail-open: kein `|| tenant`-Fallback auf den (plan-losen) Firestore-Tenant —
  // der würde einen zahlenden Pro-Kunden bei einem Lookup-Miss aussperren.
  assert.ok(
    !/findById\(data\.tenantId\)\)\s*\|\|\s*tenant/.test(middleware),
    'kein Firestore-Fallback für den Plan-Tenant (fail-closed-Regression)'
  );
  assert.ok(middleware.includes('requiresProUpgradeResolved(planTenant'),
    'Gate prüft den Plan-Tenant über den fail-open-Wrapper');
});

test('docs/api.md und api-docs.html weisen API/MCP als Pro-Feature aus', () => {
  assert.ok(/Pro-Feature/.test(apiDocs), 'docs/api.md nennt das Pro-Feature');
  assert.ok(apiDocs.includes('upgrade_required'), 'docs/api.md dokumentiert den 402-Code');
  assert.ok(/Pro-Feature/.test(apiDocsHtml), 'api-docs.html nennt das Pro-Feature');
  assert.ok(/402/.test(apiDocsHtml), 'api-docs.html nennt den 402-Downgrade-Hinweis');
});

test('/billing meldet den Enforce-Status an die UI (Master-Schalter)', () => {
  const handler = apiSource
    .split("app.get('/api/admin/tenants/:tenantSlug/billing'")[1]
    ?.split('app.post')[0] || '';
  assert.ok(handler.includes('billingEnforced: billing.billingEnforced()'),
    '/billing gibt billingEnforced zurück, damit die UI vor dem Live-Schalten offen bleibt');
});

// ---------------------------------------------------------------------------
// Board- und Release-Verwaltung über die v1-API
// ---------------------------------------------------------------------------

const v1Handler = signature => sourceSlice.handlerAfter(apiSource, signature);
const helperBody = name => sourceSlice.functionBody(apiSource, name);
const functionBodyOf = helperBody;

test('neue Scopes existieren und erweitern bestehende Schlüssel nicht', () => {
  const { API_KEY_SCOPES, normalizeScopes } = require('../api/api-key-utils');
  ['boards:write', 'releases:read', 'releases:write'].forEach(scope => {
    assert.ok(API_KEY_SCOPES.includes(scope), `Scope ${scope} muss vergebbar sein`);
  });

  // Ein bestehender Schlüssel bekommt durch die neuen Scopes nichts dazu —
  // requireApiKey prüft ausschließlich die gespeicherte Liste.
  const legacyKey = normalizeScopes(['suggestions:read', 'suggestions:write']);
  assert.deepEqual(legacyKey, ['suggestions:read', 'suggestions:write']);
  ['boards:write', 'releases:read', 'releases:write'].forEach(scope => {
    assert.equal(legacyKey.includes(scope), false, `alter Schlüssel darf ${scope} nicht erben`);
  });

  // Fehlender Scope -> 403 (unveränderte Middleware-Logik).
  assert.ok(apiSource.includes('API key is missing required scope(s)'));
  assert.ok(apiSource.includes('return res.status(403).json({'));
});

test('das Tenant-Admin-UI kann Schlüssel mit den neuen Scopes ausstellen', () => {
  ['boards:write', 'releases:read', 'releases:write'].forEach(scope => {
    assert.ok(
      tenantAdminHtml.includes(`value="${scope}"`),
      `tenant admin braucht eine Checkbox für ${scope}`
    );
  });
});

test('Board-Anlage über v1 nutzt den geteilten Pfad inkl. Free-Plan-Gate', () => {
  const body = v1Handler("app.post('/api/v1/apps', requireApiKey(['boards:write'])");
  assert.ok(
    body.includes('createTenantBoard(') && body.includes('req.apiAuth.tenant'),
    'v1 muss denselben Helfer wie die Admin-Konsole aufrufen (Board-Limit, Slug-Kollision)'
  );
  // Der Helfer selbst liefert 409 bei Slug-Kollision und 402 über dem Limit.
  const helper = helperBody('createTenantBoard');
  assert.ok(helper.includes('status: 409') && helper.includes('Tenant app slug already exists'),
    'Slug-Kollision im Tenant muss 409 liefern');
  assert.ok(helper.includes('status: 402') && helper.includes("code: 'upgrade_required'"),
    'Free-Plan-Board-Limit muss 402 upgrade_required liefern');
  // Die Statuscodes des Helfers werden unverändert durchgereicht.
  assert.ok(/status !== 201.*res\.status\(status\)\.json\(body\)/s.test(body),
    'Fehlerstatus des Helfers muss unverändert durchgereicht werden');
});

test('nachgelagerte Pro-Gates lesen den Plan aus der Plan-Quelle, nicht aus Firestore', () => {
  // Der Tenant hinter einem Schlüssel kommt aus Firestore und trägt kein `plan`.
  // Würde createTenantBoard ihn direkt prüfen, sähe es einen zahlenden Pro-Kunden
  // als Free und setzte ihm das Board-Limit vor die Nase.
  const middleware = helperBody('requireApiKey');
  assert.ok(
    middleware.includes('planTenant,'),
    'requireApiKey muss den aufgelösten Plan-Tenant an die Handler weiterreichen'
  );

  // Fail-open ist Billing-Policy und lebt in lib/billing — hier nur die
  // Verdrahtung. Die Wahrheitstabelle deckt tests/plan-gating.test.js ab.
  const billing = require('../lib/billing');
  assert.equal(
    billing.requiresProUpgradeResolved(null, { postgres: true }), false,
    'ein nicht auflösbarer Plan darf kein Gate auslösen'
  );
  assert.ok(
    helperBody('createTenantBoard').includes('billing.requiresProUpgradeResolved(planTenant,'),
    'das Board-Gate muss den Plan-Tenant über die fail-open-Variante prüfen'
  );
});

test('der Board-Slug bleibt über die API unveränderlich', () => {
  const helper = helperBody('updateTenantBoard');
  assert.ok(
    helper.includes("has('slug')") && helper.includes("has('ticketPrefix')"),
    'slug/ticketPrefix-Änderungen müssen laut abgelehnt werden, nicht still ignoriert'
  );
  assert.ok(helper.includes('slug und ticketPrefix sind unveränderlich'));
  assert.equal(helper.includes('updates.slug'), false, 'der Slug darf nie geschrieben werden');
  assert.equal(helper.includes('updates.ticketPrefix'), false, 'das Prefix darf nie geschrieben werden');
});

test('alle neuen Routen scopen hart auf den Tenant des Schlüssels (fremd = 404)', () => {
  // Boards laufen über loadApiKeyAppBySlug, das im Tenant des Keys auflöst.
  assert.ok(
    apiSource.includes('async function loadApiKeyAppBySlug(req, appSlugParam)'),
    'Board-Auflösung braucht einen tenant-gescopten Helfer'
  );
  assert.ok(
    apiSource.includes('findTenantAppBySlug(req.apiAuth.tenantId, appSlug)')
      && apiSource.includes("return { errorStatus: 404, error: 'App not found' };"),
    'ein fremdes Board muss 404 liefern, nicht 403'
  );

  [
    "app.patch('/api/v1/apps/:appSlug', requireApiKey(['boards:write'])",
    "app.get('/api/v1/apps/:appSlug/releases', requireApiKey(['releases:read'])",
    "app.post('/api/v1/apps/:appSlug/releases', requireApiKey(['releases:write'])",
  ].forEach(signature => {
    assert.ok(
      v1Handler(signature).includes('loadApiKeyAppBySlug(req, req.params.appSlug)'),
      `${signature} muss das Board im Tenant des Schlüssels auflösen`
    );
  });

  // Releases laufen über findTenantRelease(tenant, id) -> null = 404.
  ["app.patch('/api/v1/releases/:releaseId'", "app.delete('/api/v1/releases/:releaseId'"]
    .forEach(signature => {
      const body = v1Handler(signature);
      assert.ok(
        body.includes('req.apiAuth.tenant'),
        `${signature} muss den Tenant aus dem Schlüssel verwenden, nie aus dem Body`
      );
    });
  assert.ok(
    apiSource.includes("return { status: 404, body: { error: 'Release nicht gefunden' } };"),
    'ein fremdes Release muss 404 liefern, nicht 403'
  );

  // Die Zuordnung Eintrag -> Release prüft beide Seiten im Tenant.
  const assign = v1Handler("app.put('/api/v1/suggestions/:suggestionId/release'");
  assert.ok(assign.includes('loadApiKeySuggestionById(req, req.params.suggestionId)'),
    'der Eintrag muss über den tenant-gescopten Resolver kommen');
  assert.ok(assign.includes('assignSuggestionRelease('),
    'die Zuordnung muss über den geteilten Helfer laufen (prüft das Release im Tenant)');
});

test('Release-Anlage nimmt das Board aus dem Pfad, nicht aus dem Body', () => {
  const body = v1Handler("app.post('/api/v1/apps/:appSlug/releases', requireApiKey(['releases:write'])");
  assert.ok(
    body.includes('appId: tenantApp.id'),
    'die appId muss aus dem aufgelösten Board kommen — ein appId im Body darf nichts bewirken'
  );
  // Selbst wenn der Body eine fremde appId mitschickt, prüft der geteilte
  // Helfer die Board-Zugehörigkeit noch einmal gegen den Tenant.
  const helper = helperBody('createTenantRelease');
  assert.ok(
    helper.includes('appRow && appRow.tenantId === tenant.id')
      && helper.includes("getTenantId(appDoc.data() || {}) === tenant.id"),
    'createTenantRelease muss die Board-Zugehörigkeit in beiden Backends prüfen'
  );
  assert.ok(helper.includes("body: { error: 'App nicht gefunden' }"),
    'ein fremdes Board muss 404 liefern');
});

test('releaseDate: null löscht das Datum, statt ignoriert zu werden', () => {
  const helper = helperBody('updateTenantRelease');
  assert.ok(helper.includes('if (releaseDate !== undefined) {'),
    'nur undefined bedeutet "nicht gesetzt" — null muss durchlaufen');
  assert.ok(helper.includes('updateData.releaseDate = parsedReleaseDate;'),
    'der geparste Wert (null = löschen) muss in den Update wandern');
  // parseReleaseDate bildet null bewusst auf null ab (Datum entfernen) und
  // unterscheidet das vom Fehlerfall INVALID_RELEASE_DATE.
  assert.ok(functionBodyOf('parseReleaseDate').includes('value === null'),
    'parseReleaseDate muss null als "Datum entfernen" behandeln');
});

test('v1 gibt Release-Daten als ISO-Strings aus, nicht als Firestore-Shape', () => {
  assert.ok(
    apiSource.includes('function buildApiReleaseResponse(release)'),
    'Release-Antworten brauchen einen einheitlichen Mapper'
  );
  assert.ok(
    apiSource.includes('releases.map(buildApiReleaseResponse)')
      && apiSource.includes('status === 201 ? buildApiReleaseResponse(body) : body')
      && apiSource.includes('res.json(buildApiReleaseResponse(release));'),
    'GET-Liste, POST und PATCH müssen durch den Mapper laufen'
  );
  // Die Shape-Erkennung (Date / Timestamp / {_seconds}) kommt aus dem bereits
  // vorhandenen toDateOrEpoch — hier zählt nur: ISO-String, und kein Datum
  // bleibt null statt 1970.
  const mapper = helperBody('toApiDate');
  assert.ok(mapper.includes('toDateOrEpoch(value).toISOString()'),
    'der Mapper darf die Shape-Erkennung nicht erneut implementieren');
  assert.ok(mapper.includes('value ?'), 'kein Datum bleibt null, nicht 1970');
});

test('Release-Löschung verhält sich identisch zum Admin-Pfad', () => {
  const adminRoute = v1Handler("app.delete('/api/admin/tenants/:tenantSlug/releases/:releaseId'");
  const apiRoute = v1Handler("app.delete('/api/v1/releases/:releaseId'");
  assert.ok(adminRoute.includes('deleteTenantRelease(tenant, req.params.releaseId)'));
  assert.ok(apiRoute.includes('deleteTenantRelease(req.apiAuth.tenant, req.params.releaseId)'));
  // Verknüpfte Einträge werden in beiden Fällen gebündelt entkoppelt.
  const helper = helperBody('deleteTenantRelease');
  assert.ok(helper.includes('RELEASE_UNLINK_BATCH_LIMIT'));
  assert.ok(helper.includes('unlinkedSuggestions: unlinkedCount'));
});

// ---------------------------------------------------------------------------
// Import-Modus
// ---------------------------------------------------------------------------

test('der Import-Modus greift nur bei explizitem import-Block', () => {
  const body = v1Handler("app.post('/api/v1/apps/:appSlug/suggestions', requireApiKey(['suggestions:write'])");
  assert.ok(
    body.includes('suggestionImport.parseImportBlock('),
    'die Import-Validierung muss im reinen Modul liegen'
  );
  // Das Modul entscheidet am `import`-Feld — ohne Block bleibt alles beim
  // bisherigen Serververhalten.
  const { parseImportBlock } = require('../api/suggestion-import');
  assert.deepEqual(
    parseImportBlock({ type: 'feature', title: 'Normal' }, { ticketPrefix: 'FAM' }),
    { importData: null },
    'ohne import-Block darf sich eine normale Einreichung nicht ändern'
  );
  // Ohne import-Block bleibt der bisherige Pfad: Generator + plain add().
  assert.ok(body.includes('await generateTicketNumber(tenantApp.id, req.apiAuth.tenantId)'));
  assert.ok(body.includes("await db.collection('suggestions').add(suggestion)"));
});

test('Import setzt votes ohne votes-Dokumente und akzeptiert nur vergangene Daten', () => {
  const body = v1Handler("app.post('/api/v1/apps/:appSlug/suggestions', requireApiKey(['suggestions:write'])");
  assert.ok(body.includes('suggestion.votes = importData.votes;'),
    'votes setzt nur den Zähler');
  assert.equal(
    /import[\s\S]{0,400}db\.collection\('votes'\)/.test(body),
    false,
    'der Import darf keine votes-Dokumente erzeugen (Doppelabstimmungs-Sperre)'
  );
  assert.ok(body.includes('admin.firestore.Timestamp.fromDate(importData.createdAt)'),
    'createdAt überschreibt den Serverzeitstempel');
  // Zukunfts-Check lebt im reinen Modul (siehe tests/suggestion-import.test.js).
  const { parseImportBlock } = require('../api/suggestion-import');
  const future = parseImportBlock(
    { import: { createdAt: '2099-01-01T00:00:00.000Z' } },
    { ticketPrefix: 'FAM' }
  );
  assert.match(future.error, /Vergangenheit/);
});

test('Import-Schreibvorgänge sind im Audit-Log als Import erkennbar', () => {
  const body = v1Handler("app.post('/api/v1/apps/:appSlug/suggestions', requireApiKey(['suggestions:write'])");
  assert.ok(
    body.includes("logActivity(suggestionId, importData ? 'imported' : 'created'"),
    'Importe müssen eine eigene Action bekommen'
  );
  assert.ok(body.includes('via API importiert'), 'das Detail muss den Import benennen');
  assert.ok(body.includes('const actor = `api:${req.apiAuth.keyId}`;'),
    'der Actor bleibt api:<keyId>');
});

test('api-docs.html deckt die neuen Endpunkte, Scopes und den Import-Block ab', () => {
  [
    'POST /apps',
    'PATCH /apps/:appSlug',
    'GET /apps/:appSlug/releases',
    'POST /apps/:appSlug/releases',
    'PATCH /releases/:releaseId',
    'DELETE /releases/:releaseId',
    'PUT /suggestions/:id/release',
  ].forEach(fragment => {
    assert.ok(apiDocsHtml.includes(fragment), `api-docs.html muss ${fragment} dokumentieren`);
  });

  ['boards:write', 'releases:read', 'releases:write'].forEach(scope => {
    assert.ok(apiDocsHtml.includes(scope), `api-docs.html muss den Scope ${scope} dokumentieren`);
  });

  assert.ok(apiDocsHtml.includes('&quot;import&quot;') || apiDocsHtml.includes('"import"'),
    'api-docs.html muss den Import-Block zeigen');
  assert.ok(/ticketNumber/.test(apiDocsHtml) && /createdAt/.test(apiDocsHtml));
  assert.ok(/DELETE/.test(apiDocsHtml) && /30 Requests\/Minute/.test(apiDocsHtml),
    'DELETE-Rate-Limit muss dokumentiert sein');
});
