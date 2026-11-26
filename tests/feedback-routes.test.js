'use strict';

// Ohne Postgres gibt es keine Verknüpfungen: Lesen meldet „aus“, Schreiben wird
// abgelehnt, und nichts wird geschrieben.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dump, readLog, reset, seed, startApp } = require('./fake-app');
const { API_KEY_SCOPES, buildApiKeyData, generateApiKeyToken } = require('../api/api-key-utils');

const asAdmin = { authorization: 'Bearer test-admin-password' };
const token = generateApiKeyToken();
const asKey = { authorization: `Bearer ${token}` };
const REFUSED = { error: 'Verknüpfungen gibt es nur in privaten Workspaces.' };

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test.beforeEach(() => {
  reset();
  seed('tenants', 't-intern', { slug: 'intern', status: 'private', name: 'Intern', plan: 'pro' });
  seed('apps', 'app-intern', { tenantId: 't-intern', slug: 'board', name: 'Board', ticketPrefix: 'IN' });
  seed('suggestions', 's1', {
    tenantId: 't-intern', appId: 'app-intern', type: 'ticket', title: 'Titel', status: 'offen', approved: true,
  });
  seed('apiKeys', 'k1', buildApiKeyData({
    tenantId: 't-intern', name: 'Key', scopes: API_KEY_SCOPES, token,
  }));
});

// Der Schlüssel merkt sich seine letzte Nutzung; das ist kein Teil der Prüfung.
const stored = () => {
  const { apiKeys, ...rest } = structuredClone(dump());
  return rest;
};

for (const [who, url, headers] of [
  ['Konsole', '/api/admin/tenants/intern/feedback', asAdmin],
  ['v1', '/api/v1/feedback', asKey],
]) {
  test(`${who}: Lesen meldet „aus“`, async () => {
    const res = await server.request(url, { headers });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { enabled: false, sources: [], links: [] });
    assert.equal(readLog.includes('suggestions'), false);
  });
}

for (const [method, url, headers, body] of [
  ['POST', '/api/admin/tenants/intern/feedback/fetch', asAdmin, {}],
  ['POST', '/api/admin/tenants/intern/feedback/fetch', asAdmin, { dryRun: true }],
  ['PUT', '/api/admin/tenants/intern/suggestions/s1/link', asAdmin, { entryId: 'x' }],
  ['DELETE', '/api/admin/tenants/intern/suggestions/s1/link', asAdmin, undefined],
  ['POST', '/api/v1/feedback/fetch', asKey, {}],
  ['PUT', '/api/v1/suggestions/s1/link', asKey, { entryId: 'x' }],
  ['DELETE', '/api/v1/suggestions/s1/link', asKey, undefined],
]) {
  test(`${method} ${url} ${JSON.stringify(body) || ''}: 409 ohne Schreibzugriff`, async () => {
    const before = stored();

    const res = await server.request(url, { method, headers, body });

    assert.equal(res.status, 409, res.text);
    assert.deepEqual(res.body, REFUSED);
    assert.deepEqual(stored(), before);
    assert.equal(readLog.includes('suggestions'), false);
  });
}
