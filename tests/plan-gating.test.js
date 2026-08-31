const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const scriptSource = fs.readFileSync(path.join(rootDir, 'public/script.js'), 'utf8');
const boardHtml = fs.readFileSync(path.join(rootDir, 'public/index.html'), 'utf8');
const limits = require('../lib/plan-limits');

// Schneidet den Handler-Body ab einer Route-Signatur bis zum nächsten `app.<verb>(`.
function handlerAfter(signature) {
  const start = apiSource.indexOf(signature);
  assert.ok(start > -1, `Route nicht gefunden: ${signature}`);
  const rest = apiSource.slice(start + signature.length);
  const next = rest.search(/\napp\.(get|post|put|delete|use)\(/);
  return rest.slice(0, next > -1 ? next : 2000);
}

// ---------------------------------------------------------------------------
// Limits (reine Zahlen)
// ---------------------------------------------------------------------------

test('Free-Plan-Limits sind 1 Board / 2 Mitglieder', () => {
  assert.equal(limits.FREE_MAX_BOARDS, 1);
  assert.equal(limits.FREE_MAX_MEMBERS, 2);
});

// ---------------------------------------------------------------------------
// Board-Erstellung: Postgres-Pfad (Fix Geister-Board) + Gate
// ---------------------------------------------------------------------------

test('Board-Erstellung legt in Postgres tatsächlich an (kein Firestore-Ghost)', () => {
  const body = handlerAfter("app.post('/api/admin/tenants/:tenantSlug/apps'");
  assert.ok(/if \(usePostgres\(\)\)/.test(body), 'usePostgres-Branch fehlt');
  assert.ok(body.includes('repos.apps.create('), 'repos.apps.create wird nicht aufgerufen');
  assert.ok(body.includes('repos.apps.findBySlug('), 'Slug-Konflikt-Check im Postgres-Pfad fehlt');
});

test('Board-Gate hängt am zentralen Pro-Gate und liefert 402', () => {
  const body = handlerAfter("app.post('/api/admin/tenants/:tenantSlug/apps'");
  assert.ok(body.includes('billing.requiresProUpgrade(tenant, { postgres: usePostgres() })'),
    'Board-Limit muss über billing.requiresProUpgrade gaten (respektiert BILLING_ENFORCED)');
  assert.ok(body.includes('planLimits.FREE_MAX_BOARDS'), 'nutzt die zentrale Board-Grenze');
  assert.ok(body.includes('res.status(402)') && body.includes("code: 'upgrade_required'"), '402 upgrade_required erwartet');
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
