'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDatabase } = require('./helpers');

// Übersprungen, wenn keine DATABASE_URL konfiguriert ist (z.B. CI ohne DB).
const suite = hasDatabase ? test : test.skip;

const TEST_ID = 'test_tenant_repo';

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from tenants where id = $1', [TEST_ID]);
}

suite('tenants repository: create / find / update / emailSettings', async (t) => {
  const tenants = require('../../db/tenants');

  t.after(cleanup);
  await cleanup(); // frischer Start

  // create
  const created = await tenants.create({
    id: TEST_ID, name: 'Repo Test', displayName: 'Repo Test AG', slug: TEST_ID,
  });
  assert.equal(created.id, TEST_ID);
  assert.equal(created.slug, TEST_ID);
  assert.equal(created.status, 'active');
  assert.deepEqual(created.emailSettings, { fromName: null, replyTo: null });

  // findActiveBySlug findet aktive Tenants
  const found = await tenants.findActiveBySlug(TEST_ID);
  assert.equal(found.id, TEST_ID);
  assert.equal(found.displayName, 'Repo Test AG');

  // update: Status auf suspended -> findActiveBySlug liefert nichts mehr
  await tenants.update(TEST_ID, { status: 'suspended' });
  assert.equal(await tenants.findActiveBySlug(TEST_ID), null);
  const byId = await tenants.findById(TEST_ID);
  assert.equal(byId.status, 'suspended');

  // emailSettings round-trip
  await tenants.updateEmailSettings(TEST_ID, { fromName: 'Support', replyTo: 'hi@example.com' });
  const withEmail = await tenants.findById(TEST_ID);
  assert.deepEqual(withEmail.emailSettings, { fromName: 'Support', replyTo: 'hi@example.com' });

  // Billing-Spalten beschreibbar (für Stripe)
  await tenants.update(TEST_ID, { stripeCustomerId: 'cus_123', subscriptionStatus: 'active', plan: 'pro' });
  const billed = await tenants.findById(TEST_ID);
  assert.equal(billed.stripeCustomerId, 'cus_123');
  assert.equal(billed.subscriptionStatus, 'active');
  assert.equal(billed.plan, 'pro');
});
