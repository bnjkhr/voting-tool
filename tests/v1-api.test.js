const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

  // Der Lookup muss dem DATA_BACKEND-Schalter folgen. Ohne den Postgres-Zweig
  // könnte sich ein in Postgres angelegter Key nach der Umstellung gar nicht
  // authentifizieren (die Tenant-Konsole schreibt Keys dort bereits an).
  const keyLookup = apiSource
    .split('async function findApiKeyByToken(token) {')[1]
    ?.split('\nfunction requireApiKey(')[0] || '';
  assert.ok(keyLookup.length > 0, 'findApiKeyByToken muss existieren');
  assert.ok(
    keyLookup.includes('if (usePostgres())')
      && keyLookup.includes('repos.apiKeys.findByTokenHash(hashApiKeyToken(token))'),
    'unter Postgres muss der Key über repos.apiKeys.findByTokenHash aufgelöst werden'
  );
  assert.ok(
    keyLookup.includes('repos.apiKeys.touch(key.id)'),
    'lastUsedAt muss auch im Postgres-Zweig fortgeschrieben werden'
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
    apiSource.includes('await findActiveTenantById(data.tenantId)'),
    'tenant must be resolved from the key, not from the URL'
  );

  // findActiveTenantById ist das backend-bewusste Gegenstück zu
  // findActiveTenantBySlug: unter DATA_BACKEND=postgres darf hier nicht mehr
  // gegen Firestore aufgelöst werden.
  const tenantByIdHelper = apiSource
    .split('async function findActiveTenantById(tenantId) {')[1]
    ?.split('\nasync function ')[0] || '';
  assert.ok(tenantByIdHelper.length > 0, 'findActiveTenantById muss existieren');
  assert.ok(
    tenantByIdHelper.includes('if (usePostgres())')
      && tenantByIdHelper.includes('repos.tenants.findById(tenantId)'),
    'findActiveTenantById muss unter Postgres aus tenants lesen'
  );
  assert.ok(
    tenantByIdHelper.includes('isActiveTenant('),
    'inaktive Tenants müssen in beiden Backends als "nicht gefunden" gelten'
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
  // Die Tenant-Grenze selbst lebt in loadSuggestionForTenant — eine Stelle für
  // beide Backends und für beide Aufrufer (Slug-Pfad und API-Key-Pfad).
  assert.ok(
    apiSource.includes('return loadSuggestionForTenant(req.apiAuth.tenantId, suggestionId);'),
    'helper must delegate to the shared tenant-scoped lookup with the API key tenant'
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

// ---------------------------------------------------------------------------
// Postgres-Readiness: der komplette v1-Pfad muss dem DATA_BACKEND-Schalter
// folgen. Vorher lasen/schrieben mehrere v1-Handler unbedingt gegen Firestore,
// während generateTicketNumber im selben Handler bereits auf usePostgres()
// verzweigte — unter DATA_BACKEND=postgres wäre die Ticketnummer aus Postgres
// gekommen, das Dokument aber nach Firestore geschrieben worden.
// ---------------------------------------------------------------------------

// Der v1-Abschnitt zwischen den beiden Banner-Kommentaren.
const v1Section = apiSource
  .split('// Public API v1 — API-key authenticated, tenant-scoped, agent-friendly')[1]
  .split('// Tenant admin endpoints for managing API keys (owner/admin only)')[0];

test('kein v1-Zugriff auf Firestore außerhalb eines usePostgres()-Zweigs', () => {
  assert.ok(v1Section.length > 0, 'v1-Abschnitt muss gefunden werden');

  // Jeden Handler/Helper einzeln betrachten: wer db.collection() anfasst, muss
  // im selben Block auch den Postgres-Zweig haben. Ein neu hinzugefügter
  // v1-Handler ohne Backend-Verzweigung fällt damit auf.
  // Absicherung gegen einen stillen Vacuous-Pass: wenn das Splitten kaputtgeht,
  // wäre die Schleife unten leer und der Test grün ohne etwas zu prüfen.
  const allBlocks = v1Section
    .split(/\n(?=app\.(?:get|post|patch|delete)\('\/api\/v1|async function |function )/);
  const v1Routes = allBlocks.filter(block => /^app\.(get|post|patch|delete)\('\/api\/v1/.test(block));
  assert.equal(v1Routes.length, 8, `erwartet 8 v1-Routen im Abschnitt, gefunden: ${v1Routes.length}`);

  // Was danach noch direkt auf Firestore zugreift, braucht eine Backend-Weiche.
  // Null Treffer ist das Ideal (alles hinter gemeinsamen Helfern).
  const blocks = allBlocks.filter(block => block.includes("db.collection("));

  for (const block of blocks) {
    const label = block.split('\n')[0].trim().slice(0, 90);
    assert.ok(
      block.includes('usePostgres()'),
      `v1-Block greift ohne Backend-Weiche auf Firestore zu: ${label}`
    );
  }
});

test('v1-Suggestions lesen und schreiben unter Postgres über die Repositories', () => {
  const listHandler = v1Section
    .split("app.get('/api/v1/apps/:appSlug/suggestions'")[1]
    .split("app.post('/api/v1/apps/:appSlug/suggestions'")[0];
  // Tenant-Scope UND Filter gehen unter Postgres in die WHERE-Klausel, statt das
  // ganze Board zu laden und in JS wegzuwerfen.
  assert.ok(
    listHandler.includes('repos.suggestions.listByAppFiltered(tenantApp.id, req.apiAuth.tenantId, {'),
    'Liste muss unter Postgres tenant-gescopt und gefiltert aus dem Repo kommen'
  );
  // Der Firestore-Zweig hat keine WHERE-Klausel und muss weiter in JS scopen:
  // appId allein ist keine Tenant-Grenze (Board-IDs können kopiert werden).
  assert.ok(
    /\.filter\(data => getTenantId\(data\) === req\.apiAuth\.tenantId\)/.test(listHandler),
    'Firestore-Zweig muss den Tenant-Scope in JS erzwingen'
  );

  const createHandler = v1Section
    .split("app.post('/api/v1/apps/:appSlug/suggestions'")[1]
    .split("app.get('/api/v1/suggestions/:suggestionId'")[0];
  // Der Schreibpfad liegt im gemeinsamen Helper (Backend-Weiche + Screenshots).
  assert.ok(
    createHandler.includes('await createSuggestionRecord(req.apiAuth.tenantId, suggestion)'),
    'Create muss über createSuggestionRecord laufen (sonst Ticketnummer aus PG, Doc in Firestore)'
  );
  // Die vergebene ID muss auch ins Activity-Log und in die Response gehen.
  assert.ok(
    createHandler.includes("logActivity(suggestionId, 'created'")
      && createHandler.includes('buildApiSuggestionResponse({ id: suggestionId'),
    'Activity-Log und Response müssen die tatsächlich vergebene ID bekommen'
  );
});

test('v1-PATCH schreibt unter Postgres ohne Firestore-Sentinels und ohne approvedBy', () => {
  const patchHandler = v1Section
    .split("app.patch('/api/v1/suggestions/:suggestionId'")[1]
    .split("app.get('/api/v1/suggestions/:suggestionId/comments'")[0];

  assert.ok(
    patchHandler.includes('repos.suggestions.update(suggestionData.id, pgUpdates)'),
    'Update muss unter Postgres über das Repo laufen (suggestionDoc ist dort null)'
  );
  // approvedBy hat in suggestions keine Postgres-Spalte (in comments schon).
  assert.ok(
    patchHandler.includes('const { approvedBy, ...pgUpdates } = updates;'),
    'approvedBy darf nicht an das Postgres-Update durchgereicht werden'
  );
  // Zeitstempel werden backend-gerecht an der Quelle gewählt, nicht nachträglich
  // herausgepatcht — sonst schreibt ein vergessenes Feld ein Firestore-Sentinel
  // in eine timestamptz-Spalte.
  assert.ok(
    patchHandler.includes('const now = writeTimestamp();')
      && patchHandler.includes('updates.tagUpdatedAt = now;')
      && patchHandler.includes('updates.approvedAt = now;'),
    'Zeitstempel müssen über writeTimestamp() gesetzt werden'
  );
  assert.equal(
    /serverTimestamp\(\)/.test(patchHandler), false,
    'kein roher Firestore-Sentinel mehr im v1-PATCH'
  );
});

test('v1-Kommentare lesen/schreiben unter Postgres inklusive Screenshot-Attachments', () => {
  const listHandler = v1Section
    .split("app.get('/api/v1/suggestions/:suggestionId/comments'")[1]
    .split("app.post('/api/v1/suggestions/:suggestionId/comments'")[0];
  assert.ok(
    listHandler.includes('repos.comments.listForSuggestion(req.params.suggestionId)'),
    'Kommentarliste muss unter Postgres aus dem comments-Repo kommen'
  );
  assert.ok(
    listHandler.includes("getTenantId(c) === req.apiAuth.tenantId"),
    'auch der Postgres-Zweig muss auf den Key-Tenant filtern'
  );
  assert.ok(
    listHandler.includes("attachScreenshotUrls(comments, 'comment', req.apiAuth.tenant, true)"),
    'Screenshots liegen unter Postgres als attachments und brauchen Proxy-URLs'
  );

  const createHandler = v1Section.split("app.post('/api/v1/suggestions/:suggestionId/comments'")[1];
  assert.ok(
    createHandler.includes('await createCommentRecord(req.apiAuth.tenantId, comment, {'),
    'Kommentar muss über createCommentRecord laufen (Backend-Weiche + Screenshots)'
  );
  assert.ok(
    createHandler.includes("approvalStatus: 'approved'")
      && createHandler.includes('approvedBy: actor'),
    'API-Kommentare sind Admin-Kommentare, direkt freigegeben, mit dem Key als Urheber'
  );
});

test('loadSuggestionForTenant liefert unter Postgres kein Firestore-Doc und scopet beide Backends', () => {
  const helper = apiSource
    .split('async function loadSuggestionForTenant(tenantId, suggestionId) {')[1]
    .split('\nasync function resolveTenantSuggestionById')[0];
  assert.ok(helper.length > 0, 'loadSuggestionForTenant muss existieren');
  assert.ok(
    helper.includes('repos.suggestions.findById(suggestionId)'),
    'Lookup muss unter Postgres über das Repo laufen'
  );
  assert.ok(
    helper.includes('suggestionDoc: null'),
    'suggestionDoc muss unter Postgres explizit null sein — Schreibpfade dürfen sich nicht darauf verlassen'
  );
  // Cross-Tenant-Schutz in beiden Zweigen, gegen denselben übergebenen Tenant.
  assert.equal(
    (helper.match(/getTenantId\((?:suggestionData)\) !== tenantId/g) || []).length, 2,
    'beide Backends müssen gegen den übergebenen Tenant prüfen'
  );
  // Beide Backends liefern die id mit — der v1-PATCH schreibt darüber.
  assert.ok(
    helper.includes('const suggestionData = { id: suggestionDoc.id, ...suggestionDoc.data() };'),
    'auch der Firestore-Zweig muss die id mitliefern'
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
  assert.ok(middleware.includes('requiresProUpgradeResolved(tenant, { postgres: usePostgres() })'),
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
