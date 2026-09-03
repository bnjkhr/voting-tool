const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const scriptSource = fs.readFileSync(path.join(rootDir, 'public/script.js'), 'utf8');
const boardHtml = fs.readFileSync(path.join(rootDir, 'public/index.html'), 'utf8');
const limits = require('../lib/plan-limits');

// Quelltext-Slicer mit Anker-Prüfung (siehe tests/source-slice.js).
const sourceSlice = require('./source-slice');
const handlerAfter = signature => sourceSlice.handlerAfter(apiSource, signature);
const functionBody = name => sourceSlice.functionBody(apiSource, name);

// ---------------------------------------------------------------------------
// Limits (reine Zahlen)
// ---------------------------------------------------------------------------

test('Free-Plan-Limits sind 1 Board / 2 Mitglieder', () => {
  assert.equal(limits.FREE_MAX_BOARDS, 1);
  assert.equal(limits.FREE_MAX_MEMBERS, 2);
});

// ---------------------------------------------------------------------------
// Gate-ENTSCHEIDUNG (behavioral) — fängt eine Logik-Inversion rot ab, anders als
// die reinen Quelltext-Checks weiter unten. Alle Board-/Mitglieder-/Badge-Gates
// hängen an billing.requiresProUpgrade; hier wird die Wahrheitstabelle geprüft.
const billing = require('../lib/billing');

function withEnv(overrides, fn) {
  const keys = ['BILLING_ENFORCED', 'STRIPE_SECRET_KEY'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) {
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// Async-Variante: hält die Env-Overrides gesetzt, bis das (asynchrone) fn ganz
// durch ist. Nötig, weil das Gate die Env erst NACH einem `await` liest — mit
// dem synchronen withEnv wäre sie bis dahin schon zurückgesetzt.
async function withEnvAsync(overrides, fn) {
  const keys = ['BILLING_ENFORCED', 'STRIPE_SECRET_KEY'];
  const prev = {};
  for (const k of keys) prev[k] = process.env[k];
  try {
    for (const k of keys) {
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    await fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const FREE = { plan: 'free' };
const PRO = { plan: 'pro' };
const LIVE = { BILLING_ENFORCED: 'true', STRIPE_SECRET_KEY: 'sk_test_x' };

test('In der Beta (BILLING_ENFORCED aus) wird NIEMAND gegatet — jeder effektiv Pro', () => {
  withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, () => { // enforced fehlt
    assert.equal(billing.requiresProUpgrade(FREE, { postgres: true }), false,
      'ohne BILLING_ENFORCED darf ein Free-Tenant NICHT gegatet werden');
    assert.equal(billing.proGatingActive({ postgres: true }), false);
  });
});

test('Live + Free => Gate greift; Live + Pro => nicht (fängt !isProPlan-Inversion)', () => {
  withEnv(LIVE, () => {
    assert.equal(billing.requiresProUpgrade(FREE, { postgres: true }), true,
      'Live-Gating + Free muss upgrade-pflichtig sein');
    assert.equal(billing.requiresProUpgrade(PRO, { postgres: true }), false,
      'Pro-Workspace darf NIE gegatet werden — eine isProPlan-Inversion würde hier rot');
  });
});

test('Gate braucht Stripe + Postgres als Plan-Quelle', () => {
  withEnv(LIVE, () => {
    assert.equal(billing.requiresProUpgrade(FREE, { postgres: false }), false,
      'ohne Postgres (Plan-Quelle) kein Gating');
  });
  withEnv({ BILLING_ENFORCED: 'true' }, () => { // kein Stripe-Key
    assert.equal(billing.requiresProUpgrade(FREE, { postgres: true }), false,
      'ohne Stripe (Upgrade-Pfad) kein Gating');
  });
});

test('isProPlan: nur plan==="pro" ist Pro; fehlend/leer => Free', () => {
  assert.equal(billing.isProPlan(PRO), true);
  assert.equal(billing.isProPlan(FREE), false);
  assert.equal(billing.isProPlan({}), false);
  assert.equal(billing.isProPlan(null), false);
});

// ---------------------------------------------------------------------------
// API-/MCP-Gate: fail-open bei nicht auflösbarem Plan-Tenant. Der Plan-Tenant
// wird im requireApiKey-Pfad asynchron aus Postgres geladen und kann null sein
// (ID-Mismatch Firestore/Postgres oder transienter Fehler). Ein zahlender
// Pro-Kunde darf dann NICHT ausgesperrt werden.
// ---------------------------------------------------------------------------

test('requiresProUpgradeResolved: nicht auflösbarer Plan-Tenant => fail-open (kein 402 für zahlende Pro-Kunden)', () => {
  withEnv(LIVE, () => {
    // Regressionsanker: der naive requiresProUpgrade(null) failt CLOSED (true) —
    // ein plan-loser/nicht auflösbarer Tenant gilt als Free. Genau deshalb darf
    // der API-Pfad requiresProUpgrade NICHT direkt auf einen evtl. null
    // Plan-Tenant anwenden.
    assert.equal(billing.requiresProUpgrade(null, { postgres: true }), true,
      'requiresProUpgrade(null) ist fail-closed — dokumentiert die Falle');
    // Der async-sichere Wrapper failt bewusst OFFEN.
    assert.equal(billing.requiresProUpgradeResolved(null, { postgres: true }), false,
      'nicht auflösbarer Plan-Tenant (Lookup-Miss) darf NICHT sperren');
    assert.equal(billing.requiresProUpgradeResolved(undefined, { postgres: true }), false,
      'undefined (z.B. nach Lookup-Fehler) darf NICHT sperren');
  });
});

test('requiresProUpgradeResolved: aufgelöster Tenant gated exakt wie requiresProUpgrade', () => {
  withEnv(LIVE, () => {
    assert.equal(billing.requiresProUpgradeResolved(FREE, { postgres: true }), true,
      'aufgelöster Free-Tenant bleibt upgrade-pflichtig (fail-open lockert echtes Free nicht auf)');
    assert.equal(billing.requiresProUpgradeResolved(PRO, { postgres: true }), false,
      'Pro-Workspace wird nie gegatet');
  });
  withEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }, () => { // Beta: enforced aus
    assert.equal(billing.requiresProUpgradeResolved(FREE, { postgres: true }), false,
      'in der Beta wird niemand gegatet — auch der aufgelöste Tenant nicht');
  });
});

test('requireApiKey: Plan-Tenant fail-open, kein Firestore-Fallback', () => {
  const body = handlerAfter('function requireApiKey(');
  assert.ok(body.includes('repos.tenants.findById(data.tenantId)'),
    'Plan-Tenant muss aus der Postgres-Plan-Quelle geladen werden');
  // Kein Rückfall auf den (plan-losen) Firestore-Tenant — das würde einen
  // zahlenden Pro-Kunden bei einem Lookup-Miss fälschlich aussperren.
  assert.ok(!/findById\(data\.tenantId\)\)\s*\|\|\s*tenant/.test(body),
    'kein `|| tenant`-Fallback auf den Firestore-Tenant (trägt kein plan)');
  assert.ok(body.includes('billing.resolvePlanTenant('),
    'Lookup läuft über den Fail-open-Loader resolvePlanTenant');
  assert.ok(body.includes('requiresProUpgradeResolved'),
    'Gate muss über den fail-open-Wrapper requiresProUpgradeResolved laufen');
});

// resolvePlanTenant kapselt das try/catch-Swallow des Middleware-Pfads. Diese
// Tests treffen den echten Failure Mode (Loader wirft / liefert null), der zuvor
// nur in der nicht bootbaren Express-Middleware lebte und rein statisch gedeckt war.

test('resolvePlanTenant: Loader wirft => tenant=null, Fehler durchgereicht (kein Rethrow)', async () => {
  const boom = new Error('pg down');
  const result = await billing.resolvePlanTenant(async () => { throw boom; });
  assert.equal(result.tenant, null,
    'transienter Lookup-Fehler wird als null behandelt, NICHT propagiert (sonst 500 statt fail-open)');
  assert.equal(result.error, boom, 'Fehler wird fürs Logging zurückgegeben');
});

test('resolvePlanTenant: Loader liefert null/Tenant => durchgereicht ohne Fehler', async () => {
  const miss = await billing.resolvePlanTenant(async () => null);
  assert.equal(miss.tenant, null);
  assert.equal(miss.error, null, 'ein sauberer Miss ist kein Fehler');
  const hit = await billing.resolvePlanTenant(async () => PRO);
  assert.equal(hit.tenant, PRO);
  assert.equal(hit.error, null);
});

test('Fail-open Ende-zu-Ende: Lookup-Fehler sperrt einen Pro-Kunden NICHT (kein 402)', async () => {
  await withEnvAsync(LIVE, async () => {
    // Genau die Verdrahtung der Middleware: laden (fail-open) -> Gate-Entscheidung.
    const { tenant: planTenant } =
      await billing.resolvePlanTenant(async () => { throw new Error('pg down'); });
    assert.equal(billing.requiresProUpgradeResolved(planTenant, { postgres: true }), false,
      'nach einem transienten Lookup-Fehler darf das Gate NICHT greifen (fail-open)');
  });
});

// ---------------------------------------------------------------------------
// Board-Erstellung: Postgres-Pfad (Fix Geister-Board) + Gate
// ---------------------------------------------------------------------------

test('Board-Erstellung legt in Postgres tatsächlich an (kein Firestore-Ghost)', () => {
  const body = functionBody('createTenantBoard');
  assert.ok(/if \(usePostgres\(\)\)/.test(body), 'usePostgres-Branch fehlt');
  assert.ok(body.includes('repos.apps.create('), 'repos.apps.create wird nicht aufgerufen');
  assert.ok(body.includes('repos.apps.findBySlug('), 'Slug-Konflikt-Check im Postgres-Pfad fehlt');
});

test('Board-Gate hängt am zentralen Pro-Gate und liefert 402', () => {
  const body = functionBody('createTenantBoard');
  // requiresProUpgradeResolved delegiert an requiresProUpgrade und ergänzt die
  // Fail-open-Regel für einen nicht auflösbaren Plan-Tenant (API-Schlüssel-Pfad).
  assert.ok(body.includes('billing.requiresProUpgradeResolved(planTenant, { postgres: usePostgres() })'),
    'Board-Limit muss über das zentrale Pro-Gate laufen (respektiert BILLING_ENFORCED)');
  assert.ok(body.includes('planLimits.FREE_MAX_BOARDS'), 'nutzt die zentrale Board-Grenze');
  assert.ok(body.includes('status: 402') && body.includes("code: 'upgrade_required'"), '402 upgrade_required erwartet');
});

test('Admin-Konsole UND v1-API laufen durch dasselbe Board-Gate', () => {
  // Ein zweiter, nachgebauter Anlage-Pfad wäre genau die Stelle, an der das
  // Free-Plan-Board-Limit still umgangen würde.
  const adminRoute = handlerAfter("app.post('/api/admin/tenants/:tenantSlug/apps'");
  const apiRoute = handlerAfter("app.post('/api/v1/apps', requireApiKey(['boards:write'])");
  assert.ok(adminRoute.includes('createTenantBoard(tenant, req.body || {})'),
    'Admin-Route muss den geteilten Helfer aufrufen');
  assert.ok(apiRoute.includes('createTenantBoard('),
    'v1-Route muss den geteilten Helfer aufrufen');
  assert.ok(apiRoute.includes('planTenant: req.apiAuth.planTenant'),
    'v1-Route muss den Plan-Tenant aus der Plan-Quelle durchreichen, nicht den Firestore-Tenant');
  assert.equal(apiRoute.includes('planLimits.FREE_MAX_BOARDS'), false,
    'die v1-Route darf das Limit nicht nachbauen');
  assert.equal(apiRoute.includes('billing.requiresProUpgrade'), false,
    'die v1-Route darf das Gate nicht nachbauen');
});

// ---------------------------------------------------------------------------
// Team-Einladungen: Mitglieder-Gate
// ---------------------------------------------------------------------------

test('Invite-Gate zählt aktive Mitglieder + offene Invites und gated via Pro-Gate', () => {
  const body = handlerAfter("app.post('/api/admin/tenants/:tenantSlug/invites'");
  assert.ok(body.includes('billing.requiresProUpgrade(tenant, { postgres: usePostgres() })'),
    'Mitglieder-Limit muss über billing.requiresProUpgrade gaten');
  assert.ok(body.includes('repos.memberships.listByTenant') && body.includes('repos.invites.listByTenant'),
    'zählt Memberships UND offene Invites');
  assert.ok(body.includes('planLimits.FREE_MAX_MEMBERS'), 'nutzt die zentrale Mitglieder-Grenze');
  assert.ok(body.includes('res.status(402)') && body.includes("code: 'upgrade_required'"), '402 upgrade_required erwartet');
});

// ---------------------------------------------------------------------------
// Öffentliches Tenant-Endpoint: Whitelist (Leak-Fix) + Badge-Signal
// ---------------------------------------------------------------------------

test('Öffentliches GET /api/tenants/:slug ist whitelisted und leakt keine Stripe-Felder', () => {
  const body = handlerAfter("app.get('/api/tenants/:tenantSlug', async");
  assert.equal(body.includes('res.json(tenant)'), false,
    'das rohe Tenant-Objekt darf nicht mehr 1:1 zurückgegeben werden (Stripe-ID-Leak)');
  assert.equal(body.includes('stripeCustomerId'), false, 'keine Stripe-Felder in der öffentlichen Antwort');
  assert.ok(body.includes('showBadge: billing.requiresProUpgrade(tenant, { postgres: usePostgres() })'),
    'showBadge hängt am selben Pro-Gate wie die übrigen Features');
});

// ---------------------------------------------------------------------------
// Badge-Frontend
// ---------------------------------------------------------------------------

test('Öffentliches Board verdrahtet den Powered-by-Badge', () => {
  assert.ok(boardHtml.includes('id="poweredByBadge"'), 'Badge-Element im Footer fehlt');
  assert.ok(scriptSource.includes('loadTenantMeta'), 'loadTenantMeta fehlt');
  assert.ok(scriptSource.includes('/api/tenants/${encodeURIComponent(this.tenantSlug)}`'),
    'Board holt Tenant-Meta für das Badge');
  assert.ok(scriptSource.includes('poweredByBadge'), 'Badge wird per JS getoggelt');
});

// ---------------------------------------------------------------------------
// Konsole: Nutzungs-/Limit-Anzeige
// ---------------------------------------------------------------------------

test('GET /billing liefert Nutzung/Limits nur bei aktivem Gating', () => {
  const body = handlerAfter("app.get('/api/admin/tenants/:tenantSlug/billing'");
  assert.ok(body.includes('billing.proGatingActive({ postgres: usePostgres() })'),
    'usage nur zählen, wenn Gating live ist (kein Extra-Query in der Beta)');
  assert.ok(body.includes('usage'), 'usage-Feld in der Billing-Response');
  assert.ok(body.includes('planLimits.FREE_MAX_BOARDS') && body.includes('planLimits.FREE_MAX_MEMBERS'),
    'Limits kommen aus der zentralen Quelle');
});
