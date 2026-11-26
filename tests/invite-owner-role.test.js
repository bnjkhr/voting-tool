'use strict';

// Owner-Einladungen dürfen nur Owner (oder der Betreiber) ausstellen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { records, reset, seed, sentMails, startApp } = require('./fake-app');
const { buildInviteTokenHash } = require('../api/team-utils');

const INVITES = '/api/admin/tenants/acme/invites';
const asAdmin = { 'x-user-session': 'session-admin' };
const asOwner = { 'x-user-session': 'session-owner' };
const asOperator = { authorization: 'Bearer test-admin-password' };

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test.beforeEach(() => {
  reset();
  seed('tenants', 't1', { slug: 'acme', status: 'active', name: 'Acme' });
  for (const role of ['admin', 'owner']) {
    seed('users', `u-${role}`, { email: `${role}@example.test`, status: 'active' });
    seed('memberships', `m-${role}`, { tenantId: 't1', userId: `u-${role}`, role, status: 'active' });
    seed('sessions', `s-${role}`, {
      userId: `u-${role}`,
      status: 'active',
      tokenHash: buildInviteTokenHash(`session-${role}`),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    });
  }
});

function invite(headers, role) {
  return server.request(INVITES, { method: 'POST', headers, body: { email: 'neu@example.test', role } });
}

for (const role of ['owner', ' Owner ']) {
  test(`Admin kann niemanden als ${JSON.stringify(role)} einladen`, async () => {
    const res = await invite(asAdmin, role);

    assert.equal(res.status, 403);
    assert.equal(records('invites').size, 0);
    assert.equal(sentMails.length, 0);
  });
}

for (const role of ['admin', 'viewer']) {
  test(`Admin kann weiterhin als ${role} einladen`, async () => {
    const res = await invite(asAdmin, role);

    assert.equal(res.status, 201);
    assert.equal(res.body.role, role);
  });
}

for (const [who, headers] of [['Owner', asOwner], ['Betreiber', asOperator]]) {
  test(`${who} kann als Owner einladen`, async () => {
    const res = await invite(headers, 'owner');

    assert.equal(res.status, 201);
    assert.equal(res.body.role, 'owner');
    assert.equal(sentMails.length, 1);
  });
}

function seedPendingOwnerInvite() {
  seed('invites', 'invite1', {
    tenantId: 't1', email: 'neu@example.test', role: 'owner', status: 'pending',
    tokenHash: 'alt', expiresAt: new Date(Date.now() - 1000),
  });
}

test('Admin kann eine Owner-Einladung nicht erneut ausstellen', async () => {
  seedPendingOwnerInvite();
  const res = await server.request(`${INVITES}/invite1/resend`, { method: 'POST', headers: asAdmin });

  assert.equal(res.status, 403);
  assert.equal(records('invites').get('invite1').tokenHash, 'alt');
  assert.equal(sentMails.length, 0);
});

test('Owner kann eine Owner-Einladung erneut ausstellen', async () => {
  seedPendingOwnerInvite();
  const res = await server.request(`${INVITES}/invite1/resend`, { method: 'POST', headers: asOwner });

  assert.equal(res.status, 200);
  assert.notEqual(records('invites').get('invite1').tokenHash, 'alt');
  assert.equal(sentMails.length, 1);
});
