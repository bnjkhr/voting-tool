'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const api = read('api/index.js');
const adminHtml = read('public/tenant-admin.html');
const adminJs = read('public/tenant-admin.js');
const landing = read('public/landing.html');
const migration = read('migrations/0005_billing_operations.sql');

test('checkout requires recorded product-specific consent before Stripe', () => {
  assert.ok(api.includes("req.body?.acceptTerms !== true"));
  assert.ok(api.includes("req.body?.requestImmediatePerformance !== true"));
  assert.equal(api.includes('consent_collection:'), false);
  assert.ok(api.includes('billing_address_collection'));
  assert.ok(api.includes("display_name: 'Roadlight'"));
  assert.ok(api.includes("background_color: '#FAF8F5'"));
  assert.ok(api.includes("button_color: '#4F46E5'"));
  assert.ok(api.includes("integration_identifier: CHECKOUT_INTEGRATION_IDENTIFIER"));
  assert.ok(api.includes("automatic_tax: { enabled: false }"));
  assert.ok(adminHtml.includes('id="billingConsentDialog"'));
  assert.ok(adminHtml.includes('name="acceptTerms"'));
  assert.ok(adminHtml.includes('name="requestImmediatePerformance"'));
  assert.ok(adminHtml.includes('href="/agb.html"'));
  assert.ok(adminHtml.includes('href="/datenschutz.html"'));
  assert.ok(adminJs.includes('openBillingConsentDialog'));
});

test('Stripe API and checkout tracking are pinned for production', () => {
  const billing = read('lib/billing.js');
  assert.ok(billing.includes("const STRIPE_API_VERSION = '2026-07-29.dahlia'"));
  assert.ok(billing.includes('apiVersion: STRIPE_API_VERSION'));
  assert.match(api, /CHECKOUT_INTEGRATION_IDENTIFIER = 'roadlight_[a-z]{8}'/);
});

test('checkout creation is serialized and idempotent', () => {
  assert.ok(migration.includes('create table billing_checkout_sessions'));
  assert.ok(migration.includes('tenant_id                         text primary key'));
  assert.ok(api.includes('repos.billing.reserveCheckout'));
  assert.ok(api.includes('billing.validateProPrice'));
  assert.ok(api.includes('idempotencyKey: `roadlight-checkout-${attemptId}`'));
  assert.ok(api.includes('reused: true'));
});

test('webhooks deduplicate events and cover recurring invoice outcomes', () => {
  assert.ok(migration.includes('create table stripe_webhook_events'));
  assert.ok(api.includes('repos.billing.beginWebhookEvent'));
  assert.ok(api.includes('repos.billing.completeWebhookEvent'));
  assert.ok(api.includes("eventState === 'processing'"));
  assert.ok(read('db/billing.js').includes("? 'processed' : 'processing'"));
  assert.ok(read('db/billing.js').includes("interval '5 minutes'"));
  for (const eventType of [
    'invoice.created',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.payment_action_required',
    'invoice.finalization_failed',
  ]) {
    assert.ok(api.includes(eventType), `missing ${eventType}`);
  }
  assert.ok(api.includes("invoice.status !== 'draft'"));
  assert.ok(api.includes('stripe.invoices.update(invoice.id, { footer: SMALL_BUSINESS_INVOICE_FOOTER })'));
});

test('landing exposes the real Pro offer', () => {
  assert.ok(landing.includes('9&nbsp;€<span> / Monat</span>'));
  assert.ok(landing.includes('REST-API &amp; MCP-Server'));
  assert.ok(landing.includes('Jetzt verfügbar'));
  assert.equal(landing.includes('Bezahlung folgt später'), false);
});

test('production function is pinned to Frankfurt', () => {
  const config = JSON.parse(read('vercel.json'));
  assert.deepEqual(config.regions, ['fra1']);
  assert.equal(config.functions['api/index.js'].maxDuration, 30);
});

test('local server starts for Stripe CLI and browser smoke tests', () => {
  assert.ok(api.includes('if (require.main === module)'));
  assert.ok(api.includes('app.listen(port'));
});

test('public legal pages describe paid Pro and Stripe', () => {
  const terms = read('public/agb.html');
  const privacy = read('public/datenschutz.html');
  assert.ok(terms.includes('9&nbsp;&euro; pro Monat'));
  assert.equal(terms.includes('ec.europa.eu/consumers/odr'), false);
  assert.ok(privacy.includes('Stripe Payments Europe'));
});

test('production does not expose internal mockups and test pages', () => {
  assert.ok(api.includes("process.env.VERCEL_ENV === 'production'"));
  for (const pathName of ['admin-ux-proposals.html', 'mockup-1-linear.html', 'test.html']) {
    assert.ok(api.includes(`/${pathName}`));
  }
});
