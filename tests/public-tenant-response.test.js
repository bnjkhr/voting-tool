'use strict';

// Die öffentliche Workspace-Abfrage nennt nur, was zum Anzeigen nötig ist.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reset, seed, startApp } = require('./fake-app');

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test.beforeEach(() => {
  reset();
  seed('tenants', 't1', {
    name: 'Acme',
    displayName: 'Acme GmbH',
    slug: 'acme',
    status: 'active',
    legacy: false,
    emailSettings: { fromName: 'Acme', replyTo: 'antwort@example.test' },
    ownerEmail: 'inhaber@example.test',
    createdAt: new Date(),
  });
});

test('nennt genau die öffentlichen Felder', async () => {
  const res = await server.request('/api/tenants/acme');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    id: 't1', name: 'Acme', displayName: 'Acme GmbH', slug: 'acme', status: 'active',
  });
});

test('unbekannte und inaktive Workspaces bleiben unsichtbar', async () => {
  seed('tenants', 't2', { name: 'Ruht', slug: 'ruht', status: 'disabled' });

  assert.equal((await server.request('/api/tenants/ruht')).status, 404);
  assert.equal((await server.request('/api/tenants/gibt-es-nicht')).status, 404);
});
