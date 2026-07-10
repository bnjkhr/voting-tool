const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const billing = require('../lib/billing');
const apiSource = fs.readFileSync(path.join(__dirname, '..', 'api/index.js'), 'utf8');

// ---------------------------------------------------------------------------
// Reiner Mapper: Stripe-Subscription -> tenants-Billing-Felder
// ---------------------------------------------------------------------------

test('aktives Abo => Pro, mit Subscription-Id und Period-Ende', () => {
  const b = billing.mapSubscriptionToBilling({
    id: 'sub_123', status: 'active',
    current_period_end: 1790000000, trial_end: null,
  });
  assert.equal(b.plan, 'pro');
  assert.equal(b.subscriptionStatus, 'active');
  assert.equal(b.stripeSubscriptionId, 'sub_123');
  assert.equal(b.currentPeriodEnd.getTime(), 1790000000 * 1000);
  assert.equal(b.trialEndsAt, null);
});

test('trialing => Pro; trial_end wird gesetzt', () => {
  const b = billing.mapSubscriptionToBilling({ id: 'sub_t', status: 'trialing', trial_end: 1790000000 });
  assert.equal(b.plan, 'pro');
  assert.equal(b.trialEndsAt.getTime(), 1790000000 * 1000);
});

test('canceled/incomplete => Free und keine Subscription-Id', () => {
  for (const status of ['canceled', 'incomplete', 'unpaid']) {
    const b = billing.mapSubscriptionToBilling({ id: 'sub_x', status });
    assert.equal(b.plan, 'free', `${status} muss Free sein`);
    assert.equal(b.stripeSubscriptionId, null, `${status}: keine Sub-Id`);
  }
});

test('Period-Ende auch vom ersten Item lesen (neuere Stripe-API)', () => {
  const b = billing.mapSubscriptionToBilling({
    id: 'sub_i', status: 'active',
    items: { data: [{ current_period_end: 1795000000 }] },
  });
  assert.equal(b.currentPeriodEnd.getTime(), 1795000000 * 1000);
});

test('billingEnforced ist per Default aus (alle haben Premium bis zum Live-Schalten)', () => {
  const prev = process.env.BILLING_ENFORCED;
  try {
    delete process.env.BILLING_ENFORCED;
    assert.equal(billing.billingEnforced(), false, 'ohne Env => nicht erzwungen');
    process.env.BILLING_ENFORCED = 'false';
    assert.equal(billing.billingEnforced(), false, "'false' => nicht erzwungen");
    process.env.BILLING_ENFORCED = '1';
    assert.equal(billing.billingEnforced(), false, "nur exakt 'true' schaltet scharf");
    process.env.BILLING_ENFORCED = 'true';
    assert.equal(billing.billingEnforced(), true, "'true' => Gating aktiv");
  } finally {
    if (prev === undefined) delete process.env.BILLING_ENFORCED;
    else process.env.BILLING_ENFORCED = prev;
  }
});

test('isProPlan: nur plan="pro" ist Pro; fehlend/leer => Free', () => {
  assert.equal(billing.isProPlan({ plan: 'pro' }), true);
  assert.equal(billing.isProPlan({ plan: 'free' }), false);
  assert.equal(billing.isProPlan({}), false);
  assert.equal(billing.isProPlan(null), false);
  assert.equal(billing.isProPlan(undefined), false);
});

test('proGatingActive: nur wenn enforced + stripe + postgres alle zutreffen', () => {
  const prevEnforced = process.env.BILLING_ENFORCED;
  const prevStripe = process.env.STRIPE_SECRET_KEY;
  try {
    process.env.BILLING_ENFORCED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    assert.equal(billing.proGatingActive({ postgres: true }), true, 'alle drei => aktiv');
    assert.equal(billing.proGatingActive({ postgres: false }), false, 'ohne Postgres => inaktiv');
    assert.equal(billing.proGatingActive({}), false, 'ohne postgres-Flag => inaktiv');
    process.env.BILLING_ENFORCED = 'false';
    assert.equal(billing.proGatingActive({ postgres: true }), false, 'ohne Enforce => inaktiv');
    process.env.BILLING_ENFORCED = 'true';
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(billing.proGatingActive({ postgres: true }), false, 'ohne Stripe => inaktiv');
  } finally {
    if (prevEnforced === undefined) delete process.env.BILLING_ENFORCED; else process.env.BILLING_ENFORCED = prevEnforced;
    if (prevStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevStripe;
  }
});

test('requiresProUpgrade: sperrt nur bei live Gating (enforced+stripe+postgres) und Nicht-Pro', () => {
  const prevEnforced = process.env.BILLING_ENFORCED;
  const prevStripe = process.env.STRIPE_SECRET_KEY;
  try {
    // Gating vollständig live:
    process.env.BILLING_ENFORCED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    assert.equal(billing.requiresProUpgrade({ plan: 'free' }, { postgres: true }), true, 'Free + alles live => gesperrt');
    assert.equal(billing.requiresProUpgrade({ plan: 'pro' }, { postgres: true }), false, 'Pro => nie gesperrt');

    // Jede fehlende Bedingung öffnet den Zugriff (alle sind effektiv Pro):
    assert.equal(billing.requiresProUpgrade({ plan: 'free' }, { postgres: false }), false, 'ohne Postgres offen');
    assert.equal(billing.requiresProUpgrade({ plan: 'free' }, {}), false, 'ohne postgres-Flag offen');
    process.env.BILLING_ENFORCED = 'false';
    assert.equal(billing.requiresProUpgrade({ plan: 'free' }, { postgres: true }), false, 'ohne Enforce offen');
    process.env.BILLING_ENFORCED = 'true';
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(billing.requiresProUpgrade({ plan: 'free' }, { postgres: true }), false, 'ohne Stripe offen');
  } finally {
    if (prevEnforced === undefined) delete process.env.BILLING_ENFORCED; else process.env.BILLING_ENFORCED = prevEnforced;
    if (prevStripe === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevStripe;
  }
});

test('billingEnabled/getStripe sind ohne STRIPE_SECRET_KEY inaktiv', () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  try {
    delete process.env.STRIPE_SECRET_KEY;
    assert.equal(billing.billingEnabled(), false);
    assert.equal(billing.getStripe(), null);
  } finally {
    if (prev !== undefined) process.env.STRIPE_SECRET_KEY = prev;
  }
});

// ---------------------------------------------------------------------------
// Verdrahtung in index.js
// ---------------------------------------------------------------------------

test('Webhook nutzt Roh-Body (express.raw vor express.json) und Signaturprüfung', () => {
  assert.ok(apiSource.includes("app.use('/api/stripe/webhook', express.raw"));
  const rawIdx = apiSource.indexOf("express.raw({ type: 'application/json' })");
  const jsonIdx = apiSource.indexOf("app.use(express.json({ limit: '50mb' }))");
  assert.ok(rawIdx > -1 && jsonIdx > -1 && rawIdx < jsonIdx, 'Raw-Parser muss VOR express.json stehen');
  assert.ok(apiSource.includes('stripe.webhooks.constructEvent'), 'Signatur wird verifiziert');
});

test('Billing-Endpoints existieren mit korrekten Guards', () => {
  assert.ok(apiSource.includes("app.post('/api/stripe/webhook'"));
  assert.ok(apiSource.includes("app.get('/api/admin/tenants/:tenantSlug/billing', requireTenantAccess()"));
  assert.ok(apiSource.includes("app.post('/api/admin/tenants/:tenantSlug/billing/checkout', requireTenantAccess(['owner'])"));
  assert.ok(apiSource.includes("app.post('/api/admin/tenants/:tenantSlug/billing/portal', requireTenantAccess(['owner'])"));
  // Abo-Sync läuft nur in Postgres.
  assert.ok(/handleStripeEvent[\s\S]{0,120}usePostgres\(\)/.test(apiSource), 'Webhook-Handler ist postgres-gescopt');
});

test('Billing härtet gegen Out-of-Order-Events, Doppel-Abos und Nicht-Postgres', () => {
  // Out-of-Order: Subscription-Events holen den aktuellen Stand frisch.
  assert.ok(apiSource.includes('stripe.subscriptions.retrieve(event.data.object.id)'),
    'Subscription-Events re-fetchen den aktuellen Stand');
  // Herabstufung nur, wenn das Event-Abo auch das aktuell hinterlegte ist.
  assert.ok(apiSource.includes('tenant.stripeSubscriptionId !== subscription.id'),
    'Cancel eines abgelösten Abos stuft nicht mehr herab');
  // Doppel-Abo: aktives Abo -> 409 statt zweitem Checkout.
  assert.ok(apiSource.includes('billing.PRO_STATUSES.has(tenant.subscriptionStatus)'),
    'Checkout kurzschließt bei aktivem Abo');
  // Alle Billing-Admin-Endpoints sind postgres-gescopt.
  const guards = apiSource.split("if (!usePostgres()) return res.status(404).json({ error: 'Not found' }); // Billing lebt in Neon").length - 1;
  assert.ok(guards >= 3, `erwartet Postgres-Guard in GET/checkout/portal (gefunden ${guards})`);
});
