'use strict';

// Öffentliche Antworten dürfen keine Daten der einreichenden Person enthalten.
const test = require('node:test');
const assert = require('node:assert/strict');
const { reset, seed, startApp } = require('./fake-app');

const PRIVATE_FIELDS = ['notificationEmail', 'notificationEnabled', 'userFingerprint', 'authorFingerprint'];
const PRIVATE_VALUES = ['person@example.test', '203.0.113.7'];

const submitter = {
  notificationEnabled: true,
  notificationEmail: 'person@example.test',
  userFingerprint: '203.0.113.7_agent',
};

function suggestion(overrides) {
  return {
    type: 'feature',
    title: 'Dunkler Modus',
    description: 'Bitte ergänzen',
    status: 'neu',
    votes: 3,
    approved: true,
    createdAt: new Date('2026-01-01T12:00:00Z'),
    ...submitter,
    ...overrides,
  };
}

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test.beforeEach(() => {
  reset();
  seed('apps', 'legacyapp', { name: 'Altes Board' });
  seed('suggestions', 's1', suggestion({ appId: 'legacyapp', releaseId: 'r1' }));
  seed('releases', 'r1', { appId: 'legacyapp', version: '1.0', status: 'geplant' });
  seed('comments', 'c1', {
    suggestionId: 's1', text: 'Gern', authorType: 'user', approvalStatus: 'approved',
    authorFingerprint: submitter.userFingerprint,
  });

  seed('tenants', 't1', { slug: 'acme', status: 'active', name: 'Acme' });
  seed('apps', 'tenantapp', { tenantId: 't1', slug: 'board', name: 'Board' });
  seed('suggestions', 's2', suggestion({ tenantId: 't1', appId: 'tenantapp', releaseId: 'r2' }));
  seed('releases', 'r2', { tenantId: 't1', appId: 'tenantapp', version: '2.0', status: 'geplant' });
  seed('comments', 'c2', {
    tenantId: 't1', suggestionId: 's2', text: 'Gern', authorType: 'user', approvalStatus: 'approved',
    authorFingerprint: submitter.userFingerprint,
  });
});

const PUBLIC_LISTS = {
  '/api/apps/legacyapp/suggestions': 'r1',
  '/api/tenants/acme/apps/board/suggestions': 'r2',
};

for (const [url, releaseId] of Object.entries(PUBLIC_LISTS)) {
  test(`GET ${url} liefert Einträge ohne Daten der einreichenden Person`, async () => {
    const res = await server.request(url);

    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    const [item] = res.body;
    for (const field of PRIVATE_FIELDS) {
      assert.equal(field in item, false, `${field} darf nicht in der Antwort stehen`);
    }
    // Der Rest bleibt, wie ausgelieferte Clients ihn lesen.
    assert.equal(item.title, 'Dunkler Modus');
    assert.equal(item.votes, 3);
    assert.equal(item.releaseId, releaseId);
    assert.ok(item.createdAt);
    assert.equal(item.commentCount, 1);
  });
}

test('keine öffentliche GET-Antwort enthält E-Mail oder IP', async () => {
  const urls = [
    ...Object.keys(PUBLIC_LISTS),
    '/api/apps',
    '/api/apps/legacyapp/releases',
    '/api/suggestions/s1/comments',
    '/api/suggestions/s1/voted',
    '/api/tenants/acme',
    '/api/tenants/acme/apps',
    '/api/tenants/acme/apps/board',
    '/api/tenants/acme/apps/board/releases',
    '/api/tenants/acme/suggestions/s2/comments',
    '/api/tenants/acme/suggestions/s2/voted',
  ];

  for (const url of urls) {
    const res = await server.request(url);
    assert.equal(res.status, 200, url);
    for (const value of [...PRIVATE_VALUES, ...PRIVATE_FIELDS]) {
      assert.equal(res.text.includes(value), false, `${url} enthält ${value}`);
    }
  }
});

test('die Admin-Liste behält die Benachrichtigungsdaten', async () => {
  const res = await server.request('/api/admin/suggestions', {
    headers: { authorization: 'Bearer test-admin-password' },
  });

  assert.equal(res.status, 200);
  const item = res.body.find((entry) => entry.id === 's1');
  assert.equal(item.notificationEmail, 'person@example.test');
  assert.equal(item.notificationEnabled, true);
});
