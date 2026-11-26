'use strict';

// Holen und Verknüpfen über die echte App gegen Postgres. Der Altbestand liegt
// in der Firestore-Attrappe, der Quell-Workspace und das Ziel in Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDatabase } = require('./helpers');
const { TENANT_ROUTES, buildRequest } = require('../private-workspace-routes');

const suite = hasDatabase ? test : test.skip;

// Eigenes Präfix: `node --test` führt die Dateien parallel gegen eine Datenbank aus.
const INTERN = 'test_fbget_intern'; // private, Ziel
const ACME = 'test_fbget_acme'; // active, Quelle
const TENANTS = [INTERN, ACME];
const SLUG = { [INTERN]: 'test-fbget-intern', [ACME]: 'test-fbget-acme' };
const USERS = { owner: 'test_fbget_owner', viewer: 'test_fbget_viewer' };
const SESSIONS = { owner: 'test-fbget-session-owner', viewer: 'test-fbget-session-viewer' };

const LEGACY_APP = 'fbget_legacy_app';
const SOURCE_APP = 'test_fbget_acme_app';
const BOARDS = {
  alt: { id: 'test_fbget_app_alt', slug: 'altbestand', prefix: 'ALT' },
  neu: { id: 'test_fbget_app_neu', slug: 'extern', prefix: 'EXT' },
  leer: { id: 'test_fbget_app_leer', slug: 'ohne-quelle', prefix: 'LEE' },
};

// Alles, was zur einreichenden Person gehört und nie im Ziel landen darf.
const PERSONAL = [
  'person@example.test', '203.0.113.50_abdruck', 'GEHEIMBILD', 'GEHEIMPLATTFORM', 'GEHEIMSCHRITTE',
];

function bootApp() {
  const databaseUrl = process.env.DATABASE_URL;
  const fake = require('../fake-app');
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    DATA_BACKEND: 'postgres',
    BILLING_ENFORCED: '',
    BASE_URL: 'https://roadlight.example.test',
  });
  return fake.startApp().then((server) => ({ ...server, fake }));
}

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from activity where tenant_id = any($1)', [TENANTS]);
  await query('delete from tenants where id = any($1)', [TENANTS]); // cascade
  await query('delete from users where id = any($1)', [Object.values(USERS)]);
}

suite('Holen und Verknüpfen gegen Postgres', async (t) => {
  const { query, getPool } = require('../../db/pool');
  const server = await bootApp();
  const { fake } = server;
  const repos = require('../../db');
  const { generateApiKeyToken, hashApiKeyToken, API_KEY_SCOPES } = require('../../api/api-key-utils');
  const { buildInviteTokenHash } = require('../../api/team-utils');

  t.after(async () => {
    await server.close();
    await cleanup();
    await getPool().end();
  });

  let keyNumber = 0;
  let keys;
  let sources;

  async function seedKey(tenantId, scopes) {
    keyNumber += 1;
    const token = generateApiKeyToken();
    await query(
      `insert into api_keys (id, tenant_id, name, scopes, token_hash, token_prefix)
       values ($1, $2, 'Test', $3, $4, $5)`,
      [`test_fbget_key${keyNumber}`, tenantId, scopes, hashApiKeyToken(token), token.slice(0, 14)]
    );
    return { authorization: `Bearer ${token}` };
  }

  const sourceRow = (id, appId, tenantId, fields) => query(
    `insert into suggestions (id, tenant_id, app_id, type, title, description, status, priority,
       approved, approved_at, user_fingerprint, notification_enabled, notification_email,
       steps_to_reproduce, environment)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::bool, case when $9::bool then now() end,
       $10, $11, $12, $13, $14)`,
    [
      id, tenantId, appId, fields.type || 'bug', fields.title, fields.description || `Text ${id}`,
      fields.status, fields.priority || null, fields.approved !== false,
      fields.fingerprint || null, Boolean(fields.email), fields.email || null,
      fields.steps || null, fields.environment || null,
    ]
  );

  function seedLegacy() {
    fake.reset();
    fake.seed('apps', LEGACY_APP, { name: 'Altes Board', slug: 'alt' });
    const put = (id, data) => fake.seed('suggestions', id, {
      appId: LEGACY_APP, type: 'feature', description: `Text ${id}`, createdAt: new Date('2026-01-01'), ...data,
    });
    put('leg_offen', {
      title: 'Alt offen', approved: true, tag: 'wird umgesetzt', priority: 'hoch',
      userFingerprint: '203.0.113.50_abdruck', notificationEnabled: true,
      notificationEmail: 'person@example.test', screenshots: ['data:image/png;base64,GEHEIMBILD'],
      environment: { platform: 'GEHEIMPLATTFORM' }, stepsToReproduce: 'GEHEIMSCHRITTE',
    });
    put('leg_erledigt', { title: 'Alt erledigt', approved: true, tag: 'ist umgesetzt' });
    put('leg_wartet', { title: 'Alt wartet', approved: false });
    put('leg_verknuepft', { title: 'Alt verknüpft', approved: true, status: 'wird geprüft' });
    put('leg_fremd', { title: 'Fremder Mandant', approved: true, tenantId: 'anderer' });
  }

  // Frischer Stand je Testfall: Workspaces, Boards, Quellen und je Quelle ein
  // offener, ein erledigter, ein wartender und ein schon verknüpfter Eintrag.
  async function seed({ enabled = true } = {}) {
    await cleanup();
    seedLegacy();
    await query(
      `insert into tenants (id, name, slug, status, plan) values
         ($1, 'Intern', $2, 'private', 'pro'), ($3, 'Acme', $4, 'active', 'pro')`,
      [INTERN, SLUG[INTERN], ACME, SLUG[ACME]]
    );
    for (const [role, userId] of Object.entries(USERS)) {
      await query('insert into users (id, email, display_name) values ($1, $2, $3)',
        [userId, `test-fbget-${role}@example.test`, role]);
      await query(
        `insert into sessions (id, user_id, token_hash, expires_at)
         values ($1, $2, $3, now() + interval '1 day')`,
        [`${userId}_s`, userId, buildInviteTokenHash(SESSIONS[role])]
      );
      for (const tenantId of TENANTS) {
        await query('insert into memberships (id, tenant_id, user_id, role) values ($1, $2, $3, $4)',
          [`${tenantId}_${role}`, tenantId, userId, role]);
      }
    }
    for (const board of Object.values(BOARDS)) {
      await query('insert into apps (id, tenant_id, name, slug, ticket_prefix) values ($1, $2, $3, $4, $5)',
        [board.id, INTERN, `Board ${board.slug}`, board.slug, board.prefix]);
    }
    await query(
      `insert into apps (id, tenant_id, name, slug, ticket_prefix) values ($1, $2, 'Quelle', 'board', 'ACM')`,
      [SOURCE_APP, ACME]
    );

    await sourceRow('test_fbget_offen', SOURCE_APP, ACME, {
      title: 'Neu offen', status: 'im Test', priority: 'kritisch',
      fingerprint: '203.0.113.50_abdruck', email: 'person@example.test', steps: 'GEHEIMSCHRITTE',
      environment: JSON.stringify({ platform: 'GEHEIMPLATTFORM' }),
    });
    await query(
      `insert into attachments (id, tenant_id, parent_type, parent_id, content_type, size_bytes, data)
       values (gen_random_uuid(), $1, 'suggestion', 'test_fbget_offen', 'image/png', 10, $2)`,
      [ACME, Buffer.from('GEHEIMBILD')]
    );
    await sourceRow('test_fbget_erledigt', SOURCE_APP, ACME, { title: 'Neu erledigt', status: 'gelöst' });
    await sourceRow('test_fbget_wartet', SOURCE_APP, ACME, {
      title: 'Neu wartet', status: 'neu', approved: false,
    });
    await sourceRow('test_fbget_verknuepft', SOURCE_APP, ACME, { title: 'Neu verknüpft', status: 'offen' });

    sources = {
      alt: await repos.feedback.upsertSource({
        tenantId: INTERN, appId: BOARDS.alt.id, sourceKind: 'legacy', sourceAppId: LEGACY_APP,
      }),
      neu: await repos.feedback.upsertSource({
        tenantId: INTERN, appId: BOARDS.neu.id, sourceKind: 'workspace',
        sourceTenantId: ACME, sourceAppId: SOURCE_APP,
      }),
    };
    for (const [key, entryId] of [['alt', 'leg_verknuepft'], ['neu', 'test_fbget_verknuepft']]) {
      await sourceRow(`test_fbget_hand_${key}`, BOARDS[key].id, INTERN, { title: `Hand ${key}`, status: 'offen' });
      await repos.feedback.linkSuggestion({
        tenantId: INTERN, suggestionId: `test_fbget_hand_${key}`, entryId,
      });
      if (enabled) await repos.feedback.setFetchEnabled(sources[key].id, true);
    }
    await sourceRow('test_fbget_frei', BOARDS.neu.id, INTERN, { title: 'Frei', status: 'offen' });
    await sourceRow('test_fbget_ohne', BOARDS.leer.id, INTERN, { title: 'Ohne Quelle', status: 'offen' });

    keys = {
      full: await seedKey(INTERN, API_KEY_SCOPES),
      read: await seedKey(INTERN, ['suggestions:read']),
      noWrite: await seedKey(INTERN, API_KEY_SCOPES.filter((scope) => scope !== 'suggestions:write')),
      acme: await seedKey(ACME, API_KEY_SCOPES),
    };
    fake.readLog.length = 0;
  }

  const asOwner = { 'x-user-session': SESSIONS.owner };
  const asViewer = { 'x-user-session': SESSIONS.viewer };
  const base = (tenantId = INTERN) => `/api/admin/tenants/${SLUG[tenantId]}`;
  const get = (url, headers = asOwner) => server.request(url, { headers });
  const send = (method, url, body, headers = asOwner) => server.request(url, { method, body, headers });
  const consoleFetch = (body = {}) => send('POST', `${base()}/feedback/fetch`, body);
  const state = async () => (await get(`${base()}/feedback`)).body;
  const resetMarks = () => query(
    "update feedback_sources set last_fetched_at = now() - interval '6 minutes' where tenant_id = $1",
    [INTERN]
  );

  const resultFor = (res, key) => res.body.sources.find((source) => source.sourceId === sources[key].id);
  const rows = async (sql, params) => (await query(sql, params)).rows;
  const fetched = () => rows(
    `select * from suggestions where tenant_id = $1 and 'Feedback' = any(labels) order by title`,
    [INTERN]
  );
  const snapshot = async () => ({
    suggestions: await rows('select * from suggestions where tenant_id = any($1) order by id', [TENANTS]),
    apps: await rows('select * from apps where tenant_id = any($1) order by id', [TENANTS]),
    sources: await rows('select * from feedback_sources where tenant_id = $1 order by id', [INTERN]),
    links: await rows('select * from feedback_links where tenant_id = $1 order by id', [INTERN]),
    activity: await rows('select * from activity where tenant_id = any($1) order by id', [TENANTS]),
  });
  const sourceSide = async () => ({
    suggestions: await rows('select * from suggestions where tenant_id = $1 order by id', [ACME]),
    activity: await rows('select * from activity where tenant_id = $1 order by id', [ACME]),
    attachments: await rows('select id, parent_id, size_bytes from attachments where tenant_id = $1', [ACME]),
    apps: await rows('select * from apps where tenant_id = $1', [ACME]),
  });
  const firestore = () => structuredClone(fake.dump());

  await t.test('holt nur freigegebene, offene Einträge', async () => {
    await seed();

    const res = await consoleFetch();

    assert.equal(res.status, 200, res.text);
    for (const [key, prefix] of [['alt', 'ALT'], ['neu', 'EXT']]) {
      const result = resultFor(res, key);
      assert.equal(result.result, 'fetched', res.text);
      assert.equal(result.board, BOARDS[key].slug);
      assert.equal(result.unapprovedCount, 1);
      assert.equal(result.refreshed, 1);
      assert.equal(result.missing, 0);
      assert.equal(result.created.length, 1);
      assert.match(result.created[0].ticketNumber, new RegExp(`^${prefix}-001$`));
    }
    const tickets = await fetched();
    assert.deepEqual(
      tickets.map((ticket) => [ticket.title, ticket.app_id, ticket.type, ticket.status, ticket.priority, ticket.labels]),
      [
        ['Alt offen', BOARDS.alt.id, 'ticket', 'in Bearbeitung', 'hoch', ['Feedback']],
        ['Neu offen', BOARDS.neu.id, 'ticket', 'im Test', 'kritisch', ['Feedback']],
      ]
    );
    assert.ok(tickets.every((ticket) => ticket.approved && ticket.approved_at));
    const activity = await rows('select * from activity where ticket_id = any($1)', [tickets.map((x) => x.id)]);
    assert.deepEqual(activity.map((row) => [row.action, row.detail]), [
      ['created', 'Aus öffentlichem Feedback geholt'],
      ['created', 'Aus öffentlichem Feedback geholt'],
    ]);
    // Die Antwort bringt den neuen Stand gleich mit.
    assert.equal(res.body.state.enabled, true);
    assert.equal(res.body.state.links.length, 4);
    assert.deepEqual(res.body.state.sources.map((source) => source.unapprovedCount), [1, 1]);
  });

  await t.test('Stand nennt Quellen und Links je Ticket', async () => {
    await seed();
    await consoleFetch();

    const current = await state();

    assert.deepEqual(
      current.sources.map((source) => [source.appId, source.boardName, source.sourceLabel, source.fetchEnabled, source.lastError]),
      [
        [BOARDS.alt.id, 'Board altbestand', 'Altes Board', true, null],
        [BOARDS.neu.id, 'Board extern', `${SLUG[ACME]}/board`, true, null],
      ]
    );
    assert.ok(current.sources.every((source) => source.lastFetchedAt && source.id));
    const link = (entryId) => current.links.find((item) => item.entryId === entryId);
    assert.equal(link('leg_offen').url, `https://votingtool.benkohler.de/?appId=${LEGACY_APP}`);
    assert.equal(
      link('test_fbget_offen').url,
      `https://roadlight.example.test/${SLUG[ACME]}/board/t/test_fbget_offen`
    );
    assert.equal(link('test_fbget_offen').publicStatus, 'im Test');
    assert.equal(link('test_fbget_offen').publicType, 'bug');
    assert.equal(link('test_fbget_offen').publicApproved, true);
    assert.equal(link('test_fbget_offen').publicDeleted, false);
    assert.ok(link('test_fbget_offen').publicSeenAt);
    assert.ok(link('test_fbget_verknuepft').suggestionId);
    // Viewer sehen denselben Stand, ein Schlüssel auch.
    assert.deepEqual((await get(`${base()}/feedback`, asViewer)).body, current);
    assert.deepEqual((await get('/api/v1/feedback', keys.read)).body, current);
  });

  await t.test('Quelle bleibt unverändert', async () => {
    await seed();
    const before = { firestore: firestore(), postgres: await sourceSide() };

    const res = await consoleFetch();

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(fake.dump(), before.firestore);
    assert.deepEqual(await sourceSide(), before.postgres);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('nichts von der einreichenden Person', async () => {
    await seed();
    await consoleFetch();

    const tickets = await fetched();
    assert.equal(tickets.length, 2);
    for (const ticket of tickets) {
      assert.equal(ticket.notification_enabled, false);
      assert.equal(ticket.notification_email, null);
      assert.equal(ticket.user_fingerprint, 'api:feedback');
      assert.equal(ticket.environment, null);
      assert.equal(ticket.steps_to_reproduce, null);
    }
    const target = JSON.stringify(await rows(
      `select
         (select json_agg(s) from suggestions s where tenant_id = $1) as suggestions,
         (select json_agg(l) from feedback_links l where tenant_id = $1) as links,
         (select json_agg(a) from activity a where tenant_id = $1) as activity`,
      [INTERN]
    ));
    // Die Handtickets dieses Tests tragen keine persönlichen Angaben.
    for (const value of PERSONAL) assert.equal(target.includes(value), false, value);
    const attachments = await rows('select count(*)::int as n from attachments where tenant_id = $1', [INTERN]);
    assert.equal(attachments[0].n, 0);
  });

  await t.test('privat bleibt privat', async () => {
    await seed();
    await consoleFetch();
    const ids = {
      tenantSlug: SLUG[INTERN],
      appSlug: BOARDS.neu.slug,
      appId: BOARDS.neu.id,
      suggestionId: 'test_fbget_hand_neu',
      attachmentId: '00000000-0000-4000-8000-0000000000f1',
    };

    for (const entry of TENANT_ROUTES) {
      const { method, url, body } = buildRequest(entry, ids);
      const res = await server.request(url, { method, body });
      assert.equal(res.status, 404, `${entry.route}: ${res.text}`);
      assert.equal(res.body.error, 'Tenant not found', entry.route);
    }
    const publicList = await server.request(`/api/tenants/${SLUG[ACME]}/apps/board/suggestions`);
    assert.equal(publicList.status, 200, publicList.text);
    assert.ok(publicList.text.includes('Neu offen'));
    for (const title of ['Hand alt', 'Hand neu', 'Frei', 'Ohne Quelle', 'Alt offen']) {
      assert.equal(publicList.text.includes(title), false, title);
    }
    // Ohne Anmeldung verrät keine der neuen Routen etwas.
    for (const [method, url] of [
      ['GET', `${base()}/feedback`],
      ['POST', `${base()}/feedback/fetch`],
      ['PUT', `${base()}/suggestions/test_fbget_frei/link`],
      ['DELETE', `${base()}/suggestions/test_fbget_hand_neu/link`],
      ['GET', '/api/v1/feedback'],
      ['POST', '/api/v1/feedback/fetch'],
      ['PUT', '/api/v1/suggestions/test_fbget_frei/link'],
      ['DELETE', '/api/v1/suggestions/test_fbget_hand_neu/link'],
    ]) {
      const res = await server.request(url, { method, body: method === 'GET' ? undefined : { entryId: 'x' } });
      assert.equal(res.status, 401, `${method} ${url}: ${res.text}`);
    }
  });

  await t.test('zweimal parallel holen', async () => {
    await seed();

    const responses = await Promise.all([consoleFetch(), consoleFetch()]);

    for (const res of responses) assert.equal(res.status, 200, res.text);
    for (const key of ['alt', 'neu']) {
      assert.deepEqual(
        responses.map((res) => resultFor(res, key).result).sort(),
        ['fetched', 'throttled']
      );
    }
    assert.deepEqual((await fetched()).map((ticket) => ticket.title), ['Alt offen', 'Neu offen']);
  });

  await t.test('zweites Holen innerhalb von 5 Minuten', async () => {
    await seed();
    await consoleFetch();
    const before = await snapshot();
    fake.readLog.length = 0;

    const res = await consoleFetch();

    assert.equal(res.status, 200, res.text);
    for (const key of ['alt', 'neu']) {
      assert.equal(resultFor(res, key).result, 'throttled');
      assert.equal(resultFor(res, key).error, undefined);
      assert.deepEqual(resultFor(res, key).created, []);
    }
    assert.deepEqual(await snapshot(), before);
    assert.equal(fake.readLog.includes('suggestions'), false);
  });

  await t.test('nach 5 Minuten wieder, ohne doppelte Tickets', async () => {
    await seed();
    await consoleFetch();
    await resetMarks();

    const res = await consoleFetch();

    for (const key of ['alt', 'neu']) {
      assert.equal(resultFor(res, key).result, 'fetched');
      assert.deepEqual(resultFor(res, key).created, []);
      // Nichts hat sich geändert, also wird nichts geschrieben.
      assert.equal(resultFor(res, key).refreshed, 0);
      assert.equal(resultFor(res, key).pending, 0);
    }
    assert.equal((await fetched()).length, 2);
  });

  const linkVersions = () => rows(
    'select id, xmin::text as version, public_seen_at from feedback_links where tenant_id = $1 order by id',
    [INTERN]
  );

  await t.test('unveränderte Verknüpfungen werden nicht geschrieben', async () => {
    await seed();
    await consoleFetch();
    // Auch ein fehlender Eintrag wird nur einmal vermerkt.
    fake.records('suggestions').delete('leg_offen');
    await resetMarks();
    await consoleFetch();
    const before = await linkVersions();
    await resetMarks();

    await consoleFetch();

    assert.deepEqual(await linkVersions(), before);
  });

  // Weitere offene Einträge in der Workspace-Quelle.
  const addOpen = async (...ids) => {
    for (const id of ids) await sourceRow(id, SOURCE_APP, ACME, { title: `Neu ${id}`, status: 'offen' });
  };
  // Stört das Anlegen: `before` läuft vor jedem Aufruf und darf werfen.
  const interceptCreate = (before) => {
    const original = repos.feedback.createTicketWithLink;
    let calls = 0;
    repos.feedback.createTicketWithLink = async (input) => {
      calls += 1;
      await before(input, calls);
      return original(input);
    };
    return () => { repos.feedback.createTicketWithLink = original; };
  };

  await t.test('ein fehlerhafter Eintrag bricht die Quelle nicht ab', async () => {
    await seed();
    await addOpen('test_fbget_zwei', 'test_fbget_drei');
    const restore = interceptCreate((input) => {
      if (input.entry.id === 'test_fbget_zwei') throw new Error('kaputter Eintrag');
    });
    let res;
    try {
      res = await consoleFetch();
    } finally {
      restore();
    }

    assert.equal(res.status, 200, res.text);
    const result = resultFor(res, 'neu');
    assert.equal(result.result, 'error');
    assert.equal(result.error, '1 Eintrag ließ sich nicht holen.');
    assert.equal(result.failed, 1);
    assert.equal(result.pending, 0);
    assert.deepEqual(result.created.map((item) => item.title).sort(), ['Neu offen', 'Neu test_fbget_drei']);
    assert.equal(result.unapprovedCount, 1);
    const stored = res.body.state.sources.find((source) => source.id === sources.neu.id);
    assert.equal(stored.lastError, '1 Eintrag ließ sich nicht holen.');
    assert.equal(stored.unapprovedCount, 1);
    assert.equal(resultFor(res, 'alt').result, 'fetched');
    // Beim nächsten Holen kommt er nach, und der Fehler ist weg.
    await resetMarks();
    const again = await consoleFetch();
    assert.deepEqual(resultFor(again, 'neu').created.map((item) => item.title), ['Neu test_fbget_zwei']);
    assert.equal(again.body.state.sources.find((source) => source.id === sources.neu.id).lastError, null);
  });

  await t.test('Zeitgrenze: Rest steht aus, der nächste Aufruf macht ohne Sperre weiter', async () => {
    await seed();
    await addOpen('test_fbget_zwei', 'test_fbget_drei');
    await repos.feedback.setFetchEnabled(sources.alt.id, false);
    const realNow = Date.now;
    let skew = 0;
    // Nach dem ersten Ticket ist die Zeit um.
    const restore = interceptCreate((input, calls) => { if (calls === 1) skew = 25000; });
    Date.now = () => realNow() + skew;
    let res;
    try {
      res = await consoleFetch();
    } finally {
      Date.now = realNow;
      restore();
    }

    assert.equal(res.status, 200, res.text);
    const result = resultFor(res, 'neu');
    assert.equal(result.result, 'fetched');
    assert.equal(result.created.length, 1);
    assert.equal(result.pending, 2);
    assert.equal(result.unapprovedCount, 1);
    const stored = res.body.state.sources.find((source) => source.id === sources.neu.id);
    assert.equal(stored.lastFetchedAt, null);
    assert.equal(stored.unapprovedCount, 1);
    assert.equal(stored.lastError, null);

    const next = await consoleFetch();

    assert.equal(resultFor(next, 'neu').result, 'fetched');
    assert.equal(resultFor(next, 'neu').created.length, 2);
    assert.equal(resultFor(next, 'neu').pending, 0);
    assert.equal((await fetched()).length, 3);
    assert.equal(resultFor(await consoleFetch(), 'neu').result, 'throttled');
  });

  await t.test('Ausschalten stoppt einen laufenden Lauf', async () => {
    await seed();
    await addOpen('test_fbget_zwei', 'test_fbget_drei');
    const restore = interceptCreate(async (input, calls) => {
      if (calls === 2) await repos.feedback.setFetchEnabled(sources.neu.id, false);
    });
    await repos.feedback.setFetchEnabled(sources.alt.id, false);
    let res;
    try {
      res = await consoleFetch();
    } finally {
      restore();
    }

    assert.equal(res.status, 200, res.text);
    assert.equal(resultFor(res, 'neu').created.length, 1);
    assert.equal((await fetched()).length, 1);
  });

  await t.test('lässt sich nach dem Holen nur der Stand nicht laden, kommt der Bericht', async () => {
    for (const headers of ['console', 'v1']) {
      await seed();
      const original = repos.feedback.listLinks;
      repos.feedback.listLinks = async () => { throw new Error('Stand gestört'); };
      let res;
      try {
        res = headers === 'console'
          ? await consoleFetch()
          : await send('POST', '/api/v1/feedback/fetch', {}, keys.full);
      } finally {
        repos.feedback.listLinks = original;
      }

      assert.equal(res.status, 200, res.text);
      assert.equal(res.body.state, undefined);
      assert.deepEqual(res.body.sources.map((source) => source.result), ['fetched', 'fetched']);
      assert.equal(res.body.sources.flatMap((source) => source.created).length, 2);
    }
  });

  await t.test('Probelauf schreibt nichts', async () => {
    await seed({ enabled: false });
    const before = { postgres: await snapshot(), firestore: firestore() };

    const res = await consoleFetch({ dryRun: true });

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(resultFor(res, 'alt').wouldCreate, [{
      entryId: 'leg_offen', title: 'Alt offen', publicStatus: 'wird umgesetzt',
      url: `https://votingtool.benkohler.de/?appId=${LEGACY_APP}`,
    }]);
    assert.deepEqual(resultFor(res, 'neu').wouldCreate, [{
      entryId: 'test_fbget_offen', title: 'Neu offen', publicStatus: 'im Test',
      url: `https://roadlight.example.test/${SLUG[ACME]}/board/t/test_fbget_offen`,
    }]);
    for (const key of ['alt', 'neu']) {
      assert.deepEqual(resultFor(res, key).created, []);
      assert.equal(resultFor(res, key).unapprovedCount, 1);
    }
    assert.deepEqual(await snapshot(), before.postgres);
    assert.deepEqual(fake.dump(), before.firestore);
  });

  await t.test('Probelauf meldet von Hand verknüpfte Einträge, die es nicht gibt', async () => {
    await seed();
    await repos.feedback.linkSuggestion({ tenantId: INTERN, suggestionId: 'test_fbget_frei', entryId: 'vertippt' });
    const before = await snapshot();

    const res = await consoleFetch({ dryRun: true });

    assert.equal(resultFor(res, 'neu').missing, 1);
    assert.deepEqual(await snapshot(), before);
    // Gelöst zählt die vertippte ID nicht mehr: Nur verknüpfte Tickets fehlen.
    await repos.feedback.unlinkSuggestion({ tenantId: INTERN, suggestionId: 'test_fbget_frei' });
    assert.equal(resultFor(await consoleFetch({ dryRun: true }), 'neu').missing, 0);
  });

  await t.test('dryRun muss ein Wahrheitswert sein', async () => {
    await seed();
    const before = await snapshot();

    for (const dryRun of ['true', 1, null]) {
      const res = await consoleFetch({ dryRun });
      assert.equal(res.status, 400, `${JSON.stringify(dryRun)}: ${res.text}`);
      const v1 = await send('POST', '/api/v1/feedback/fetch', { dryRun }, keys.full);
      assert.equal(v1.status, 400, `${JSON.stringify(dryRun)}: ${v1.text}`);
    }

    assert.deepEqual(await snapshot(), before);
  });

  await t.test('ohne enable kein Holen', async () => {
    await seed({ enabled: false });
    const before = await snapshot();

    const res = await consoleFetch();

    assert.deepEqual(res.body.sources.map((source) => source.result), ['disabled', 'disabled']);
    assert.deepEqual(await snapshot(), before);
    assert.equal(fake.readLog.includes('suggestions'), false);
  });

  await t.test('Altbestand scheitert, Workspace nicht', async () => {
    await seed();
    const restore = fake.failReads('suggestions');
    try {
      const res = await consoleFetch();

      assert.equal(res.status, 200, res.text);
      assert.equal(resultFor(res, 'alt').result, 'error');
      assert.equal(resultFor(res, 'alt').error, 'Die Quelle ließ sich nicht holen.');
      assert.equal(resultFor(res, 'neu').result, 'fetched');
      assert.deepEqual((await fetched()).map((ticket) => ticket.title), ['Neu offen']);
      const stored = res.body.state.sources.find((source) => source.id === sources.alt.id);
      assert.equal(stored.lastError, 'Die Quelle ließ sich nicht holen.');
      // Innerhalb der 5 Minuten bleibt der Fehler sichtbar.
      const again = await consoleFetch();
      assert.equal(resultFor(again, 'alt').result, 'throttled');
      assert.equal(resultFor(again, 'alt').error, 'Die Quelle ließ sich nicht holen.');
    } finally {
      restore();
    }
    await resetMarks();
    const recovered = await consoleFetch();
    assert.equal(resultFor(recovered, 'alt').result, 'fetched');
    assert.equal((await state()).sources.find((source) => source.id === sources.alt.id).lastError, null);
  });

  await t.test('hängender Altbestand wird abgebrochen', { timeout: 30000 }, async () => {
    await seed();
    const restore = fake.failReads('suggestions', { hang: true });
    try {
      const res = await consoleFetch();

      assert.equal(res.status, 200, res.text);
      assert.equal(resultFor(res, 'alt').result, 'error');
      assert.equal(resultFor(res, 'neu').result, 'fetched');
    } finally {
      restore();
    }
  });

  await t.test('ausgeblendetes Board im Altbestand wird nicht gelesen', async () => {
    await seed();
    fake.seed('apps', LEGACY_APP, { name: 'Altes Board', publicHidden: true });

    const res = await consoleFetch();

    assert.equal(resultFor(res, 'alt').result, 'error');
    assert.equal(resultFor(res, 'alt').error, 'Das öffentliche Board ist nicht erreichbar.');
    assert.equal(fake.readLog.includes('suggestions'), false);
  });

  for (const status of ['private', 'suspended']) {
    await t.test(`Quell-Workspace ${status} wird nicht gelesen`, async () => {
      await seed();
      await query('update tenants set status = $2 where id = $1', [ACME, status]);

      const res = await consoleFetch();

      assert.equal(resultFor(res, 'neu').result, 'error');
      assert.equal(resultFor(res, 'neu').error, 'Der Quell-Workspace ist nicht öffentlich erreichbar.');
      assert.deepEqual(resultFor(res, 'neu').created, []);
      assert.deepEqual((await fetched()).map((ticket) => ticket.title), ['Alt offen']);
      const current = res.body.state;
      assert.equal(current.sources.find((s) => s.id === sources.neu.id).sourceLabel, 'Quelle nicht erreichbar');
      assert.equal(current.links.find((link) => link.entryId === 'test_fbget_verknuepft').url, null);
    });
  }

  await t.test('Lesen liest nie den Altbestand', async () => {
    await seed();
    await consoleFetch();
    const restore = fake.failReads('suggestions');
    fake.readLog.length = 0;
    try {
      for (const [url, headers] of [
        [`${base()}/feedback`, asOwner],
        [`${base()}/suggestions`, asOwner],
        [`/api/v1/apps/${BOARDS.alt.slug}/suggestions`, keys.full],
        ['/api/v1/feedback', keys.full],
      ]) {
        const res = await get(url, headers);
        assert.equal(res.status, 200, `${url}: ${res.text}`);
      }
      assert.deepEqual(fake.readLog, []);
    } finally {
      restore();
    }
  });

  await t.test('Status, gelöscht, nicht freigegeben', async () => {
    await seed();
    await consoleFetch();
    const ticketsBefore = await fetched();
    await query("update suggestions set status = 'gelöst' where id = 'test_fbget_offen'");
    await query(
      "update suggestions set approved = false, approved_at = null where id = 'test_fbget_verknuepft'"
    );
    fake.records('suggestions').delete('leg_offen');
    await repos.feedback.linkSuggestion({ tenantId: INTERN, suggestionId: 'test_fbget_frei', entryId: 'vertippt' });
    await resetMarks();

    const res = await consoleFetch();

    const link = (entryId) => res.body.state.links.find((item) => item.entryId === entryId);
    assert.equal(link('test_fbget_offen').publicStatus, 'gelöst');
    assert.equal(link('test_fbget_verknuepft').publicApproved, false);
    assert.equal(link('leg_offen').publicDeleted, true);
    assert.equal(link('leg_offen').publicStatus, 'wird umgesetzt');
    assert.ok(link('leg_offen').publicSeenAt);
    assert.equal(link('vertippt').publicDeleted, true);
    assert.equal(link('vertippt').publicSeenAt, null);
    assert.equal(resultFor(res, 'alt').missing, 1);
    assert.equal(resultFor(res, 'neu').missing, 1);
    // Intern bleibt führend.
    assert.deepEqual(await fetched(), ticketsBefore);
  });

  await t.test('gelöschtes und gelöstes Ticket kommt nicht wieder', async () => {
    await seed();
    await consoleFetch();
    const [alt, neu] = await fetched();
    await repos.suggestions.remove(alt.id);
    const unlinked = await send('DELETE', `${base()}/suggestions/${neu.id}/link`);
    assert.equal(unlinked.status, 200, unlinked.text);
    await resetMarks();

    const res = await consoleFetch();

    for (const key of ['alt', 'neu']) assert.deepEqual(resultFor(res, key).created, []);
    assert.deepEqual((await fetched()).map((ticket) => ticket.id), [neu.id]);
  });

  for (const [who, prefix, headersOf] of [
    ['Konsole', () => `${base()}`, () => asOwner],
    ['v1', () => '/api/v1', () => keys.full],
  ]) {
    await t.test(`Verknüpfen und lösen (${who})`, async () => {
      await seed();
      const url = (id) => `${prefix()}/suggestions/${id}/link`;
      const put = (id, entryId) => send('PUT', url(id), { entryId }, headersOf());
      fake.readLog.length = 0;

      const linked = await put('test_fbget_frei', 'test_fbget_offen');
      assert.equal(linked.status, 200, linked.text);
      assert.deepEqual(linked.body, {
        suggestionId: 'test_fbget_frei', entryId: 'test_fbget_offen',
        publicType: null, publicStatus: null, publicApproved: null, publicDeleted: false, publicSeenAt: null,
        url: `https://roadlight.example.test/${SLUG[ACME]}/board/t/test_fbget_offen`,
        pendingStatus: null, pendingReason: null, pendingMail: false, pendingError: null,
        pushStage: null, pushEnabled: false,
      });
      assert.equal((await put('test_fbget_frei', 'test_fbget_offen')).status, 200);

      const taken = await put('test_fbget_hand_neu', 'test_fbget_offen');
      assert.equal(taken.status, 409, taken.text);
      assert.equal(taken.body.error, 'Der Eintrag oder das Ticket ist schon verknüpft.');
      assert.equal((await put('test_fbget_frei', 'ein_anderer')).status, 409);

      const noSource = await put('test_fbget_ohne', 'x');
      assert.equal(noSource.status, 404, noSource.text);
      assert.equal(noSource.body.error, 'An diesem Board ist keine öffentliche Quelle angeschlossen.');
      // Fremdes und unbekanntes Ticket sehen gleich aus.
      for (const id of ['test_fbget_offen', 'gibtsnicht']) {
        const res = await put(id, 'x');
        assert.equal(res.status, 404, res.text);
        assert.equal(res.body.error, 'Suggestion not found');
      }
      for (const entryId of ['', 'a b', '../x', 'x'.repeat(65), 7, undefined, ['abc']]) {
        const res = await put('test_fbget_frei', entryId);
        assert.equal(res.status, 400, `${JSON.stringify(entryId)}: ${res.text}`);
      }
      assert.equal(fake.readLog.includes('suggestions'), false);

      const removed = await send('DELETE', url('test_fbget_frei'), undefined, headersOf());
      assert.equal(removed.status, 200, removed.text);
      const again = await send('DELETE', url('test_fbget_frei'), undefined, headersOf());
      assert.equal(again.status, 404, again.text);
      const foreign = await send('DELETE', url('test_fbget_offen'), undefined, headersOf());
      assert.equal(foreign.status, 404, foreign.text);
      assert.equal((await fetched()).length, 0);
    });
  }

  await t.test('Verknüpfen nur privat', async () => {
    await seed();
    const before = await snapshot();
    const body = { entryId: 'x' };
    const refused = { error: 'Verknüpfungen gibt es nur in privaten Workspaces.' };

    for (const [method, url, headers] of [
      ['PUT', `${base(ACME)}/suggestions/test_fbget_offen/link`, asOwner],
      ['DELETE', `${base(ACME)}/suggestions/test_fbget_offen/link`, asOwner],
      ['POST', `${base(ACME)}/feedback/fetch`, asOwner],
      ['PUT', '/api/v1/suggestions/test_fbget_offen/link', keys.acme],
      ['DELETE', '/api/v1/suggestions/test_fbget_offen/link', keys.acme],
      ['POST', '/api/v1/feedback/fetch', keys.acme],
    ]) {
      const res = await send(method, url, body, headers);
      assert.equal(res.status, 409, `${method} ${url}: ${res.text}`);
      assert.deepEqual(res.body, refused);
    }
    const empty = { enabled: false, sources: [], links: [] };
    assert.deepEqual((await get(`${base(ACME)}/feedback`)).body, empty);
    assert.deepEqual((await get('/api/v1/feedback', keys.acme)).body, empty);

    for (const [method, url, headers] of [
      ['PUT', `${base()}/suggestions/test_fbget_frei/link`, asViewer],
      ['DELETE', `${base()}/suggestions/test_fbget_hand_neu/link`, asViewer],
      ['POST', `${base()}/feedback/fetch`, asViewer],
      ['PUT', '/api/v1/suggestions/test_fbget_frei/link', keys.noWrite],
      ['DELETE', '/api/v1/suggestions/test_fbget_hand_neu/link', keys.noWrite],
    ]) {
      const res = await send(method, url, body, headers);
      assert.equal(res.status, 403, `${method} ${url}: ${res.text}`);
    }
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('Holen mit Lese-Schlüssel', async () => {
    await seed();
    const before = await snapshot();

    for (const body of [{}, { dryRun: false }, undefined]) {
      const res = await send('POST', '/api/v1/feedback/fetch', body, keys.read);
      assert.equal(res.status, 403, res.text);
    }
    assert.deepEqual(await snapshot(), before);
    const dry = await send('POST', '/api/v1/feedback/fetch', { dryRun: true }, keys.read);
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.body.sources.length, 2);
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('v1 holt mit Schreibrecht', async () => {
    await seed();

    const res = await send('POST', '/api/v1/feedback/fetch', {}, keys.full);

    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.sources.map((source) => source.result), ['fetched', 'fetched']);
    assert.equal(res.body.state.links.length, 4);
    const activity = await rows(
      "select actor from activity where tenant_id = $1 and action = 'created'", [INTERN]
    );
    assert.ok(activity.length === 2 && activity.every((row) => row.actor.startsWith('api:')));
  });

  await t.test('Holen ist je Schlüssel gebremst, andere Aufrufe zählen nicht mit', async () => {
    await seed();
    for (let i = 0; i < 15; i += 1) await get('/api/v1/feedback', keys.full);

    for (let i = 1; i <= 10; i += 1) {
      const res = await send('POST', '/api/v1/feedback/fetch', { dryRun: true }, keys.full);
      assert.equal(res.status, 200, `Aufruf ${i}: ${res.text}`);
    }
    const res = await send('POST', '/api/v1/feedback/fetch', { dryRun: true }, keys.full);

    assert.equal(res.status, 429, res.text);
    assert.equal((await send('POST', '/api/v1/feedback/fetch', { dryRun: true }, keys.read)).status, 200);
  });
});
