'use strict';

// Derselbe Schutz im Postgres-Betrieb: die Repositories liefern die Spalten
// camelCase und vollständig, die öffentliche Antwort darf sie nicht durchreichen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./fake-app');
const repos = require('../db');
const { mapRow } = require('../db/rows');

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test('öffentliche Tenant-Liste unter Postgres ohne Daten der einreichenden Person', async (t) => {
  process.env.DATA_BACKEND = 'postgres';
  t.after(() => { process.env.DATA_BACKEND = ''; });

  t.mock.method(repos.tenants, 'findActiveBySlug', async () => ({ id: 't1', slug: 'acme', status: 'active' }));
  t.mock.method(repos.apps, 'findBySlug', async () => ({ id: 'app1', tenantId: 't1', slug: 'board' }));
  t.mock.method(repos.suggestions, 'listPublicForApp', async () => [mapRow({
    id: 's1',
    tenant_id: 't1',
    app_id: 'app1',
    type: 'feature',
    title: 'Dunkler Modus',
    status: 'neu',
    votes: 3,
    approved: true,
    user_fingerprint: '203.0.113.7_agent',
    notification_enabled: true,
    notification_email: 'person@example.test',
    created_at: new Date('2026-01-01T12:00:00Z'),
  })]);
  t.mock.method(repos.comments, 'statsForSuggestions', async () => ({}));
  t.mock.method(repos.votes, 'votedSuggestionIds', async () => []);
  t.mock.method(repos.attachments, 'listForParents', async () => []);

  const res = await server.request('/api/tenants/acme/apps/board/suggestions');

  assert.equal(res.status, 200);
  assert.equal(res.body[0].title, 'Dunkler Modus');
  assert.equal(res.body[0].votes, 3);
  for (const value of ['userFingerprint', 'notificationEmail', 'notificationEnabled', 'person@example.test', '203.0.113.7']) {
    assert.equal(res.text.includes(value), false, `Antwort enthält ${value}`);
  }
});
