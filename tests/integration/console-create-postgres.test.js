'use strict';

// Anlegen im Board der Konsole über die echte App gegen Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDatabase } = require('./helpers');

const suite = hasDatabase ? test : test.skip;

// Eigenes Präfix: `node --test` führt die Dateien parallel gegen eine Datenbank aus.
const INTERN = 'test_concr_intern';
const ACME = 'test_concr_acme';
const TENANTS = [INTERN, ACME];
const SLUG = { [INTERN]: 'test-concr-intern', [ACME]: 'test-concr-acme' };
const APP = { [INTERN]: `${INTERN}_app`, [ACME]: `${ACME}_app` };
const USER_ID = 'test_concr_owner';
const SESSION = 'test-concr-session';

function bootApp() {
  const databaseUrl = process.env.DATABASE_URL;
  const fake = require('../fake-app');
  Object.assign(process.env, { DATABASE_URL: databaseUrl, DATA_BACKEND: 'postgres', BILLING_ENFORCED: '' });
  return fake.startApp().then((server) => ({ ...server, sentMails: fake.sentMails }));
}

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from activity where tenant_id = any($1)', [TENANTS]);
  await query('delete from tenants where id = any($1)', [TENANTS]); // cascade
  await query('delete from users where id = $1', [USER_ID]); // cascade: sessions
}

suite('Anlegen im Board gegen Postgres', async (t) => {
  const { query, getPool } = require('../../db/pool');
  const { buildInviteTokenHash } = require('../../api/team-utils');
  const server = await bootApp();

  t.after(async () => {
    await server.close();
    await cleanup();
    await getPool().end();
  });

  await cleanup();
  await query(
    `insert into tenants (id, name, slug, status, plan) values
       ($1, 'Intern', $2, 'private', 'pro'), ($3, 'Acme', $4, 'active', 'pro')`,
    [INTERN, SLUG[INTERN], ACME, SLUG[ACME]]
  );
  await query('insert into users (id, email, display_name) values ($1, $2, $3)',
    [USER_ID, 'test-concr-owner@example.test', 'Owner']);
  await query(
    `insert into sessions (id, user_id, token_hash, expires_at)
     values ($1, $2, $3, now() + interval '1 day')`,
    [`${USER_ID}_s`, USER_ID, buildInviteTokenHash(SESSION)]
  );
  for (const tenantId of TENANTS) {
    await query(
      `insert into memberships (id, tenant_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [`${tenantId}_m`, tenantId, USER_ID]
    );
    await query(
      `insert into apps (id, tenant_id, name, slug, ticket_prefix) values ($1, $2, 'Web', 'web', 'CC')`,
      [APP[tenantId], tenantId]
    );
  }

  const asOwner = { 'x-user-session': SESSION };
  const create = (tenantId, body) => server.request(`/api/admin/tenants/${SLUG[tenantId]}/suggestions`, {
    method: 'POST', headers: asOwner, body: { appId: APP[tenantId], title: 'Export als PDF', ...body },
  });
  const count = async () => (await query(
    'select count(*)::int as n from suggestions where tenant_id = any($1)', [TENANTS]
  )).rows[0].n;
  const counter = async () => (await query(
    'select next_ticket_number as n from apps where id = $1', [APP[INTERN]]
  )).rows[0].n;

  await t.test('legt ein Ticket an, das die Konsole gleich zeigt', async () => {
    const res = await create(INTERN, { description: 'Mit < und >', priority: 'kritisch', status: 'wartend' });

    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.ticketNumber, 'CC-001');
    const { rows: [row] } = await query('select * from suggestions where id = $1', [res.body.id]);
    assert.deepEqual(
      [row.tenant_id, row.app_id, row.type, row.title, row.description, row.status, row.tag, row.priority],
      [INTERN, APP[INTERN], 'ticket', 'Export als PDF', 'Mit < und >', 'wartend', null, 'kritisch'],
    );
    assert.deepEqual(
      [row.approved, row.labels, row.votes, row.notification_enabled, row.notification_email, row.user_fingerprint, row.ticket_number],
      [true, [], 0, false, null, 'api:console', 'CC-001'],
    );
    assert.ok(row.approved_at instanceof Date);
    assert.ok(row.created_at instanceof Date);

    const { rows: activity } = await query('select * from activity where ticket_id = $1', [res.body.id]);
    assert.deepEqual(activity.map((entry) => [entry.tenant_id, entry.action]), [[INTERN, 'created']]);
    assert.equal(server.sentMails.length, 0);

    const list = await server.request(`/api/admin/tenants/${SLUG[INTERN]}/suggestions`, { headers: asOwner });
    assert.deepEqual(list.body.map((item) => [item.id, item.status, item.app.name]), [[res.body.id, 'wartend', 'Web']]);
    // Aus dem Alter der Boards entsteht ihre Farbe.
    const apps = await server.request(`/api/admin/tenants/${SLUG[INTERN]}/apps`, { headers: asOwner });
    assert.ok(Number.isFinite(Date.parse(apps.body[0].createdAt)));
  });

  await t.test('gleichzeitiges Anlegen vergibt jede Nummer einmal', async () => {
    const answers = await Promise.all(Array.from({ length: 8 }, (_, i) => create(INTERN, { title: `Parallel ${i}` })));

    assert.deepEqual(answers.map((res) => res.status), Array(8).fill(201));
    assert.deepEqual(
      answers.map((res) => res.body.ticketNumber).sort(),
      Array.from({ length: 8 }, (_, i) => `CC-00${i + 2}`),
    );
  });

  await t.test('Abgelehntes schreibt nichts und verbraucht keine Nummer', async () => {
    const before = [await count(), await counter()];
    const answers = [
      await create(INTERN, { appId: APP[ACME] }),
      await create(INTERN, { status: 'gelöst' }),
      await create(INTERN, { title: 'a\u0000b' }),
      await create(ACME, {}),
    ];

    assert.deepEqual(answers.map((res) => res.status), [404, 400, 400, 403]);
    assert.deepEqual([await count(), await counter()], before);
  });
});
