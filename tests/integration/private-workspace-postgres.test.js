'use strict';

// Privater Workspace gegen echtes Postgres (DATA_BACKEND=postgres) und mit
// scharfem Pro-Gating. Firestore und Mailversand liegen als Attrappe im
// Speicher, Stripe wird mit einem Dummy-Schlüssel nie angesprochen.

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDatabase } = require('./helpers');
const {
  MARKER,
  OTHER_PUBLIC_ROUTES,
  TENANT_ROUTES,
  buildRequest,
} = require('../private-workspace-routes');

const suite = hasDatabase ? test : test.skip;

const OWNER = 'test-privat-owner@example.test';
const UNKNOWN_EMAIL = 'unbekannt@example.test';
const USER_ID = 'test_privat_user';
const SESSION_TOKEN = 'test-privat-session';
const ADMIN_PASSWORD = 'test-admin-passwort-nur-fuer-diesen-lauf';

const WORKSPACES = {
  intern: { status: 'private', label: MARKER, attachmentId: '00000000-0000-4000-8000-0000000000a1' },
  acme: { status: 'active', label: 'Acme', attachmentId: '00000000-0000-4000-8000-0000000000a2' },
  aus: { status: 'suspended', label: MARKER, attachmentId: '00000000-0000-4000-8000-0000000000a3' },
};
const tenantId = (key) => `test_privat_${key}`;
const slugOf = (key) => `test-privat-${key}`;
const TENANT_IDS = Object.keys(WORKSPACES).map(tenantId);

function idsFor(key) {
  return {
    tenantSlug: slugOf(key),
    appSlug: 'board',
    appId: `${tenantId(key)}_app`,
    suggestionId: `${tenantId(key)}_s`,
    attachmentId: WORKSPACES[key].attachmentId,
    inviteToken: `einladung-${slugOf(key)}`,
    email: OWNER,
  };
}

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from activity where tenant_id = any($1)', [TENANT_IDS]);
  await query('delete from tenants where id = any($1)', [TENANT_IDS]); // cascade
  await query('delete from users where id = $1', [USER_ID]); // cascade: sessions
}

// Die Attrappe leert beim Laden die Umgebung; die Datenbank-URL und die
// Schalter dieses Laufs werden danach gesetzt, vor dem Laden der App.
function bootApp() {
  const databaseUrl = process.env.DATABASE_URL;
  const fake = require('../fake-app');
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    DATA_BACKEND: 'postgres',
    BILLING_ENFORCED: 'true',
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: '',
    ADMIN_PASSWORD,
  });
  return fake.startApp().then((server) => ({ ...server, sentMails: fake.sentMails }));
}

async function seed(tokens) {
  const { query } = require('../../db/pool');
  const { hashApiKeyToken, API_KEY_SCOPES } = require('../../api/api-key-utils');
  const { buildInviteTokenHash } = require('../../api/team-utils');

  await query('insert into users (id, email, display_name) values ($1, $2, $3)', [USER_ID, OWNER, 'Owner']);
  await query(
    `insert into sessions (id, user_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '1 day')`,
    ['test_privat_sess', USER_ID, buildInviteTokenHash(SESSION_TOKEN)]
  );

  for (const [key, { status, label, attachmentId }] of Object.entries(WORKSPACES)) {
    const id = tenantId(key);
    const ids = idsFor(key);
    await query(
      `insert into tenants (id, name, display_name, slug, status, plan)
       values ($1, $2, $2, $3, $4, 'pro')`,
      [id, `${label} Workspace`, ids.tenantSlug, status]
    );
    await query(
      `insert into memberships (id, tenant_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [`${id}_m`, id, USER_ID]
    );
    await query(
      `insert into apps (id, tenant_id, name, slug, ticket_prefix) values ($1, $2, $3, 'board', 'PW')`,
      [ids.appId, id, `${label} Board`]
    );
    await query(
      `insert into releases (id, tenant_id, app_id, version, title) values ($1, $2, $3, '1.0', $4)`,
      [`${id}_r`, id, ids.appId, `${label} Release`]
    );
    await query(
      `insert into suggestions (id, tenant_id, app_id, type, title, description, status, approved, approved_at, release_id)
       values ($1, $2, $3, 'feature', $4, $5, 'wird geprüft', true, now(), $6)`,
      [ids.suggestionId, id, ids.appId, `${label} Titel`, `${label} Text`, `${id}_r`]
    );
    await query(
      `insert into comments (id, tenant_id, suggestion_id, text, author_type, approval_status)
       values ($1, $2, $3, $4, 'user', 'approved')`,
      [`${id}_c`, id, ids.suggestionId, `${label} Kommentar`]
    );
    await query(
      `insert into attachments (id, tenant_id, parent_type, parent_id, content_type, size_bytes, data)
       values ($1, $2, 'suggestion', $3, 'image/png', $4, $5)`,
      [attachmentId, id, ids.suggestionId, label.length, Buffer.from(label)]
    );
    await query(
      `insert into invites (id, tenant_id, email, role, token_hash, expires_at)
       values ($1, $2, $3, 'viewer', $4, now() + interval '1 day')`,
      [`${id}_i`, id, `gast-${key}@example.test`, buildInviteTokenHash(ids.inviteToken)]
    );
    await query(
      `insert into api_keys (id, tenant_id, name, scopes, token_hash, token_prefix)
       values ($1, $2, $3, $4, $5, $6)`,
      [`${id}_k`, id, `${label} Key`, API_KEY_SCOPES, hashApiKeyToken(tokens[key]), tokens[key].slice(0, 14)]
    );
  }
}

// Zeilenstände der Tabellen, in die eine öffentliche Anfrage schreiben könnte.
// Auf die Daten dieses Tests begrenzt: Die anderen Integrationstests laufen
// gleichzeitig gegen dieselbe Datenbank.
async function snapshot() {
  const { query } = require('../../db/pool');
  const { rows } = await query(
    `select
       (select json_agg(t order by t.id) from tenants t where id = any($1)) as tenants,
       (select json_agg(s order by s.id) from suggestions s where tenant_id = any($1)) as suggestions,
       (select json_agg(c order by c.id) from comments c where tenant_id = any($1)) as comments,
       (select json_agg(v order by v.id) from votes v where tenant_id = any($1)) as votes,
       (select json_agg(i order by i.id) from invites i where tenant_id = any($1)) as invites,
       (select json_agg(m order by m.id) from memberships m where tenant_id = any($1)) as memberships,
       (select json_agg(u order by u.id) from users u where email = any($2::citext[])) as users,
       (select count(*) from login_links where email = any($2::citext[])) as login_links`,
    [TENANT_IDS, [OWNER, UNKNOWN_EMAIL]]
  );
  return rows[0];
}

suite('privater Workspace gegen Postgres', async (t) => {
  const { generateApiKeyToken, API_KEY_SCOPES } = require('../../api/api-key-utils');
  const tokens = Object.fromEntries(Object.keys(WORKSPACES).map((key) => [key, generateApiKeyToken()]));

  const server = await bootApp();
  t.after(async () => {
    await server.close();
    await cleanup();
  });
  await cleanup();
  await seed(tokens);

  const asUser = { 'x-user-session': SESSION_TOKEN };
  const asAdmin = { authorization: `Bearer ${ADMIN_PASSWORD}` };
  const asKey = (key) => ({ authorization: `Bearer ${tokens[key]}` });
  const call = (entry, ids) => {
    const { method, url, body } = buildRequest(entry, ids);
    return server.request(url, { method, body });
  };
  const consoleBase = `/api/admin/tenants/${slugOf('intern')}`;

  await t.test('Pro-Gating ist in diesem Lauf scharf', () => {
    const billing = require('../../lib/billing');
    assert.equal(billing.requiresProUpgrade({ plan: 'free' }, { postgres: true }), true);
  });

  await t.test('öffentliche Tenant-Routen: privat wie unbekannt', async (tt) => {
    for (const entry of TENANT_ROUTES) {
      await tt.test(entry.route, async () => {
        const before = await snapshot();
        const res = await call(entry, idsFor('intern'));
        const unknown = await call(entry, { ...idsFor('intern'), tenantSlug: 'gibtsnicht' });

        assert.equal(res.status, 404, res.text);
        assert.equal(res.body.error, 'Tenant not found');
        assert.equal(res.text, unknown.text);
        assert.deepEqual(await snapshot(), before);
      });
    }
  });

  await t.test('übrige öffentliche Routen verraten nichts Privates', async (tt) => {
    for (const entry of OTHER_PUBLIC_ROUTES) {
      await tt.test(entry.route, async () => {
        const before = await snapshot();
        const res = await call(entry, idsFor('intern'));

        assert.notEqual(res.status, 500, res.text);
        assert.equal(res.text.includes(MARKER), false, res.text.slice(0, 300));
        assert.deepEqual(await snapshot(), before);
        assert.equal(server.sentMails.length, 0);
      });
    }
  });

  // Stolperdraht: Die Route liest heute nur Firestore und kann deshalb nicht rot
  // werden. Sie soll auffallen, sobald sie aus Postgres liest.
  await t.test('Benachrichtigungs-Einstellungen liefern nichts Privates', async () => {
    const res = await server.request('/api/user/notification-settings', { headers: asUser });

    assert.equal(res.status, 200, res.text);
    assert.equal(res.text.includes(MARKER), false);
  });

  await t.test('Gegenprobe: aktiver Workspace kommt an der Prüfung vorbei', async (tt) => {
    for (const entry of TENANT_ROUTES) {
      await tt.test(entry.route, async () => {
        const res = await call(entry, idsFor('acme'));

        assert.notEqual(res.body?.error, 'Tenant not found');
        assert.notEqual(res.status, 500, res.text);
      });
    }
  });

  await t.test('Sitzung listet den privaten Workspace', async () => {
    const res = await server.request('/api/auth/session', { headers: asUser });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(
      res.body.memberships.map((m) => m.tenantSlug).sort(),
      [slugOf('acme'), slugOf('intern')]
    );
  });

  for (const [who, headers] of [['Sitzung', asUser], ['Admin-Passwort', asAdmin]]) {
    await t.test(`Konsole (${who}) erreicht den privaten Workspace`, async () => {
      const ids = idsFor('intern');
      const base = `${consoleBase}/suggestions/${ids.suggestionId}`;

      for (const url of [`${consoleBase}/apps`, `${consoleBase}/suggestions`, `${base}/comments`]) {
        const res = await server.request(url, { headers });
        assert.equal(res.status, 200, `GET ${url}: ${res.text}`);
        assert.ok(res.text.includes(MARKER), `GET ${url} liefert die Inhalte`);
      }

      const comment = `${tenantId('intern')}_c`;
      const writes = [
        ['POST', `${base}/approve`, undefined, 200],
        ['PUT', `${base}/status`, { status: 'wird umgesetzt' }, 200],
        ['PUT', `${base}/priority`, { priority: 'hoch' }, 200],
        ['PUT', `${base}/release`, { releaseId: `${tenantId('intern')}_r` }, 200],
        ['POST', `${base}/comments`, { text: 'Notiz' }, 201],
        ['PUT', `${base}/comments/${comment}/approve`, undefined, 200],
        ['PUT', `${base}/comments/${comment}/reject`, undefined, 200],
      ];
      for (const [method, url, body, expected] of writes) {
        const res = await server.request(url, { method, body, headers });
        assert.equal(res.status, expected, `${method} ${url}: ${res.text}`);
      }

      const attachment = await server.request(`${consoleBase}/attachments/${ids.attachmentId}`, { headers });
      assert.equal(attachment.status, 200, attachment.text);
    });
  }

  await t.test('API-Schlüssel arbeitet im privaten Workspace (Plan pro)', async () => {
    const me = await server.request('/api/v1/me', { headers: asKey('intern') });
    assert.equal(me.status, 200, me.text);
    assert.equal(me.body.tenant.slug, slugOf('intern'));

    const created = await server.request('/api/v1/apps/board/suggestions', {
      method: 'POST', headers: asKey('intern'),
      body: { type: 'ticket', title: 'Aufgabe', description: 'Zu tun' },
    });
    assert.equal(created.status, 201, created.text);

    const patched = await server.request(`/api/v1/suggestions/${created.body.id}`, {
      method: 'PATCH', headers: asKey('intern'), body: { status: 'in Bearbeitung' },
    });
    assert.equal(patched.status, 200, patched.text);
    assert.equal(patched.body.status, 'in Bearbeitung');
  });

  await t.test('API-Schlüssel anlegen (Plan pro)', async () => {
    const res = await server.request(`${consoleBase}/api-keys`, {
      method: 'POST', headers: asUser, body: { name: 'MCP', scopes: API_KEY_SCOPES },
    });

    assert.equal(res.status, 201, res.text);
  });

  await t.test('Einladungen in private Workspaces werden abgelehnt', async () => {
    const invites = `${consoleBase}/invites`;
    const before = await snapshot();
    const mails = server.sentMails.length;
    const created = await server.request(invites, {
      method: 'POST', headers: asUser, body: { email: 'neu@example.test', role: 'viewer' },
    });
    const resent = await server.request(`${invites}/${tenantId('intern')}_i/resend`, {
      method: 'POST', headers: asUser,
    });

    assert.equal(created.status, 409, created.text);
    assert.equal(resent.status, 409, resent.text);
    assert.deepEqual((await snapshot()).invites, before.invites);
    assert.equal(server.sentMails.length, mails);
  });

  await t.test('Einstellungen speichern lässt den Status', async () => {
    const res = await server.request(`${consoleBase}/settings`, {
      method: 'PUT', headers: asUser,
      body: { workspaceName: 'Neuer Name', workspaceSlug: slugOf('intern'), boardName: 'Board', ticketPrefix: 'PW' },
    });
    assert.equal(res.status, 200, res.text);

    const { query } = require('../../db/pool');
    const { rows } = await query('select name, status from tenants where id = $1', [tenantId('intern')]);
    assert.deepEqual(rows[0], { name: 'Neuer Name', status: 'private' });
  });

  await t.test('gesperrt bleibt gesperrt', async () => {
    const open = await server.request(`/api/tenants/${slugOf('aus')}`);
    const consoleRead = await server.request(`/api/admin/tenants/${slugOf('aus')}/apps`, { headers: asUser });
    const key = await server.request('/api/v1/me', { headers: asKey('aus') });

    assert.equal(open.status, 404);
    assert.equal(consoleRead.status, 404);
    assert.equal(key.status, 403);
  });
});
