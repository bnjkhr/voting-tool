'use strict';

// Ein privater Workspace ist ohne Anmeldung wie nicht vorhanden; Konsole und
// API-Schlüssel arbeiten darin wie in einem aktiven.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dump, records, reset, seed, sentMails, startApp } = require('./fake-app');
const {
  MARKER,
  OTHER_PUBLIC_ROUTES,
  TENANT_ROUTES,
  buildRequest,
  readRegistrations,
  readUnauthenticatedRoutes,
} = require('./private-workspace-routes');
const { buildInviteTokenHash } = require('../api/team-utils');
const { API_KEY_SCOPES, buildApiKeyData, generateApiKeyToken } = require('../api/api-key-utils');

const OWNER = 'ben@example.test';
const ATTACHMENT_ID = '00000000-0000-4000-8000-000000000001';
const asOwner = { 'x-user-session': 'session-ben' };

const WORKSPACES = [
  { key: 'intern', status: 'private', suggestionId: 's1', label: MARKER },
  { key: 'acme', status: 'active', suggestionId: 's2', label: 'Acme' },
  { key: 'aus', status: 'suspended', suggestionId: 's3', label: MARKER },
];
const tokens = Object.fromEntries(WORKSPACES.map(({ key }) => [key, generateApiKeyToken()]));
const asKey = (key) => ({ authorization: `Bearer ${tokens[key]}` });

function idsFor(key) {
  const { suggestionId } = WORKSPACES.find((workspace) => workspace.key === key);
  return {
    tenantSlug: key,
    appSlug: 'board',
    appId: `app-${key}`,
    suggestionId,
    attachmentId: ATTACHMENT_ID,
    inviteToken: `einladung-${key}`,
    email: OWNER,
  };
}

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test.beforeEach(() => {
  reset();
  seed('users', 'u-ben', { email: OWNER, status: 'active', displayName: 'Ben' });
  seed('sessions', 'sess-ben', {
    userId: 'u-ben',
    status: 'active',
    tokenHash: buildInviteTokenHash('session-ben'),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
  });

  for (const { key, status, suggestionId, label } of WORKSPACES) {
    const tenantId = `t-${key}`;
    const appId = `app-${key}`;
    seed('tenants', tenantId, { slug: key, status, name: `${label} Workspace`, plan: 'pro' });
    seed('memberships', `m-${key}`, { tenantId, userId: 'u-ben', role: 'owner', status: 'active' });
    seed('apps', appId, { tenantId, slug: 'board', name: `${label} Board`, ticketPrefix: 'IN' });
    seed('suggestions', suggestionId, {
      tenantId, appId, type: 'feature', title: `${label} Titel`, description: `${label} Text`,
      status: 'wird geprüft', approved: true, votes: 1, createdAt: new Date(),
    });
    seed('comments', `c-${key}`, {
      tenantId, suggestionId, text: `${label} Kommentar`, authorType: 'user',
      approvalStatus: 'approved', createdAt: new Date(),
    });
    seed('releases', `r-${key}`, {
      tenantId, appId, version: '1.0', title: `${label} Release`, status: 'geplant', createdAt: new Date(),
    });
    seed('invites', `i-${key}`, {
      tenantId, email: `gast-${key}@example.test`, role: 'viewer', status: 'pending',
      tokenHash: buildInviteTokenHash(`einladung-${key}`), expiresAt: new Date(Date.now() + 86400000),
    });
    seed('apiKeys', `k-${key}`, buildApiKeyData({
      tenantId, name: `${label} Key`, scopes: API_KEY_SCOPES, token: tokens[key],
    }));
  }
});

function call(entry, ids, headers) {
  const { method, url, body } = buildRequest(entry, ids);
  return server.request(url, { method, body, headers });
}

const firestoreTenantRoutes = TENANT_ROUTES.filter((entry) => !entry.postgresOnly);

test('jede Route ohne Anmeldung ist eingeordnet', () => {
  const listed = [...TENANT_ROUTES, ...OTHER_PUBLIC_ROUTES].map(({ route }) => route);

  assert.deepEqual(readUnauthenticatedRoutes().sort(), listed.sort());
  assert.equal(TENANT_ROUTES.length, 12);
  for (const entry of OTHER_PUBLIC_ROUTES) assert.ok(entry.reason, `${entry.route} ohne Begründung`);
});

test('öffentliche Tenant-Routen: privat wie unbekannt', async (t) => {
  for (const entry of firestoreTenantRoutes) {
    await t.test(entry.route, async () => {
      const before = structuredClone(dump());
      const res = await call(entry, idsFor('intern'));
      const unknown = await call(entry, { ...idsFor('intern'), tenantSlug: 'gibtsnicht' });

      assert.equal(res.status, 404, res.text);
      assert.equal(res.body.error, 'Tenant not found');
      assert.equal(res.text, unknown.text);
      assert.deepEqual(dump(), before);
    });
  }
});

test('Gegenprobe: aktiver Workspace kommt an der Prüfung vorbei', async (t) => {
  for (const entry of firestoreTenantRoutes) {
    await t.test(entry.route, async () => {
      const res = await call(entry, idsFor('acme'));

      assert.notEqual(res.body?.error, 'Tenant not found');
      assert.notEqual(res.status, 500, res.text);
    });
  }
});

test('übrige öffentliche Routen verraten nichts Privates', async (t) => {
  for (const entry of OTHER_PUBLIC_ROUTES) {
    await t.test(entry.route, async () => {
      const before = structuredClone(dump());
      const res = await call(entry, idsFor('intern'));

      assert.notEqual(res.status, 500, res.text);
      assert.equal(res.text.includes(MARKER), false, res.text.slice(0, 300));
      assert.deepEqual(dump(), before);
      assert.equal(sentMails.length, 0);
    });
  }
});

test('Sitzung listet den privaten Workspace', async () => {
  const res = await server.request('/api/auth/session', { headers: asOwner });

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.memberships.map((m) => m.tenantSlug).sort(), ['acme', 'intern']);
});

test('Konsole erreicht den privaten Workspace', async () => {
  const base = '/api/admin/tenants/intern';
  const get = (path) => server.request(`${base}${path}`, { headers: asOwner });
  const send = (method, path, body) => server.request(`${base}${path}`, { method, body, headers: asOwner });

  for (const path of ['/apps', '/suggestions', '/suggestions/s1/comments']) {
    const res = await get(path);
    assert.equal(res.status, 200, `GET ${path}: ${res.text}`);
    assert.ok(res.text.includes(MARKER), `GET ${path} liefert die Inhalte`);
  }

  // Jeder angemeldete Schreibweg, der einen Eintrag nachschlägt.
  const writes = [
    ['POST', '/suggestions/s1/approve', undefined, 200],
    ['PUT', '/suggestions/s1/status', { status: 'wird umgesetzt' }, 200],
    ['PUT', '/suggestions/s1/priority', { priority: 'hoch' }, 200],
    ['PUT', '/suggestions/s1/release', { releaseId: 'r-intern' }, 200],
    ['POST', '/suggestions/s1/comments', { text: 'Notiz' }, 201],
    ['PUT', '/suggestions/s1/comments/c-intern/approve', undefined, 200],
    ['PUT', '/suggestions/s1/comments/c-intern/reject', undefined, 200],
  ];
  for (const [method, path, body, expected] of writes) {
    const res = await send(method, path, body);
    assert.equal(res.status, expected, `${method} ${path}: ${res.text}`);
  }

  const stored = records('suggestions').get('s1');
  assert.equal(stored.status, 'wird umgesetzt');
  assert.equal(stored.priority, 'hoch');
  assert.equal(stored.releaseId, 'r-intern');
  assert.equal(records('comments').get('c-intern').approvalStatus, 'rejected');
});

test('Konsole zeigt im privaten Workspace keine fremden Einträge', async () => {
  const res = await server.request('/api/admin/tenants/intern/suggestions/s2/comments', { headers: asOwner });

  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'Suggestion not found');
});

test('API-Schlüssel arbeitet im privaten Workspace', async () => {
  const me = await server.request('/api/v1/me', { headers: asKey('intern') });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.body.tenant.slug, 'intern');

  const created = await server.request('/api/v1/apps/board/suggestions', {
    method: 'POST', headers: asKey('intern'),
    body: { type: 'ticket', title: 'Aufgabe', description: 'Zu tun' },
  });
  assert.equal(created.status, 201, created.text);

  const patched = await server.request(`/api/v1/suggestions/${created.body.id}`, {
    method: 'PATCH', headers: asKey('intern'), body: { status: 'in Bearbeitung' },
  });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(records('suggestions').get(created.body.id).status, 'in Bearbeitung');
});

test('Einladungen in private Workspaces werden abgelehnt', async () => {
  const invites = '/api/admin/tenants/intern/invites';
  const before = structuredClone(records('invites').get('i-intern'));

  const created = await server.request(invites, {
    method: 'POST', headers: asOwner, body: { email: 'neu@example.test', role: 'viewer' },
  });
  const resent = await server.request(`${invites}/i-intern/resend`, { method: 'POST', headers: asOwner });

  for (const res of [created, resent]) {
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body.error, 'Private Workspaces haben keine Einladungen.');
  }
  assert.equal(records('invites').size, WORKSPACES.length);
  assert.deepEqual(records('invites').get('i-intern'), before);
  assert.equal(sentMails.length, 0);
});

test('alle Konsolen-Lesewege finden den Workspace', async (t) => {
  const reads = readRegistrations().filter(({ route, handlers }) => (
    route.startsWith('GET ') && handlers.includes('requireTenantAccess(')
  ));
  assert.ok(reads.length >= 9, `nur ${reads.length} Lesewege gefunden`);

  for (const { route } of reads) {
    await t.test(route, async () => {
      const res = await call({ route }, idsFor('intern'), asOwner);

      assert.notEqual(res.body?.error, 'Tenant not found');
      assert.notEqual(res.status, 500, res.text);
    });
  }
});

test('API-Schlüssel anlegen', async () => {
  const res = await server.request('/api/admin/tenants/intern/api-keys', {
    method: 'POST', headers: asOwner, body: { name: 'MCP', scopes: API_KEY_SCOPES },
  });

  assert.equal(res.status, 201, res.text);
});

test('Einstellungen speichern lässt den Status', async () => {
  const res = await server.request('/api/admin/tenants/intern/settings', {
    method: 'PUT', headers: asOwner,
    body: { workspaceName: 'Neuer Name', workspaceSlug: 'intern', boardName: 'Board', ticketPrefix: 'IN' },
  });

  assert.equal(res.status, 200, res.text);
  assert.equal(records('tenants').get('t-intern').name, 'Neuer Name');
  assert.equal(records('tenants').get('t-intern').status, 'private');
});

test('gesperrt bleibt gesperrt', async () => {
  const open = await server.request('/api/tenants/aus');
  const consoleRead = await server.request('/api/admin/tenants/aus/apps', { headers: asOwner });
  const key = await server.request('/api/v1/me', { headers: asKey('aus') });

  assert.equal(open.status, 404);
  assert.equal(consoleRead.status, 404);
  assert.equal(key.status, 403);
});
