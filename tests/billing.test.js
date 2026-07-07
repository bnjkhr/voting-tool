const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const billing = require('../api/billing');
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
