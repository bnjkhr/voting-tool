'use strict';

// Zurückschreiben über die echte App gegen Postgres. Der Altbestand liegt in der
// Firestore-Attrappe, der Quell-Workspace und das Ziel in Postgres. Mails gehen
// an die Resend-Attrappe und werden dort nur gezählt.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDatabase } = require('./helpers');

const suite = hasDatabase ? test : test.skip;

// Eigenes Präfix: `node --test` führt die Dateien parallel gegen eine Datenbank aus.
const INTERN = 'test_fbpushapi_intern'; // private, Ziel
const ACME = 'test_fbpushapi_acme'; // active, Quelle
const TENANTS = [INTERN, ACME];
const SLUG = { [INTERN]: 'test-fbpushapi-intern', [ACME]: 'test-fbpushapi-acme' };
const ROLES = ['owner', 'admin', 'viewer'];
const userId = (role) => `test_fbpushapi_${role}`;
const sessionToken = (role) => `test-fbpushapi-session-${role}`;
const consoleMail = (role) => `test-fbpushapi-${role}@example.test`;

const LEGACY_APP = 'fbpushapi_legacy_app';
const SOURCE_APP = 'test_fbpushapi_acme_app';
const OTHER_APP = 'test_fbpushapi_acme_other';
const BOARDS = {
  alt: { id: 'test_fbpushapi_app_alt', slug: 'altbestand', prefix: 'ALT' },
  neu: { id: 'test_fbpushapi_app_neu', slug: 'extern', prefix: 'EXT' },
};

const RECIPIENT = 'person@example.test';
const SETTINGS_RECIPIENT = 'einstellung@example.test';
const FINGERPRINT = '203.0.113.60_abdruck';
const LEGACY_FROM = 'Altes Board <alt@example.test>';
const ROADLIGHT_FROM = 'Roadlight <hallo@example.test>';
const NOTIFY = { notificationEnabled: true, notificationEmail: RECIPIENT };

function bootApp() {
  const databaseUrl = process.env.DATABASE_URL;
  const fake = require('../fake-app');
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    DATA_BACKEND: 'postgres',
    BILLING_ENFORCED: '',
    BASE_URL: 'https://roadlight.example.test',
    LEGACY_EMAIL_FROM: LEGACY_FROM,
    EMAIL_FROM: ROADLIGHT_FROM,
  });
  return fake.startApp().then((server) => ({ ...server, fake }));
}

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from activity where tenant_id = any($1)', [TENANTS]);
  await query('delete from tenants where id = any($1)', [TENANTS]); // cascade
  await query('delete from users where id = any($1)', [ROLES.map(userId)]);
}

suite('Zurückschreiben gegen Postgres', async (t) => {
  const { query, getPool } = require('../../db/pool');
  const server = await bootApp();
  const { fake } = server;
  const repos = require('../../db');
  const { PUSH_MESSAGES } = require('../../lib/feedback-push');
  const { generateApiKeyToken, hashApiKeyToken, API_KEY_SCOPES } = require('../../api/api-key-utils');
  const { buildInviteTokenHash } = require('../../api/team-utils');

  t.after(async () => {
    await server.close();
    await cleanup();
    await getPool().end();
  });

  let number = 0;
  let keys;
  let sources;
  // Alles, was die App während eines Testfalls ins Log schreibt.
  const logged = [];

  const rows = async (sql, params) => (await query(sql, params)).rows;

  async function seedKey(tenantId, scopes) {
    number += 1;
    const token = generateApiKeyToken();
    await query(
      `insert into api_keys (id, tenant_id, name, scopes, token_hash, token_prefix)
       values ($1, $2, 'Test', $3, $4, $5)`,
      [`test_fbpushapi_key${number}`, tenantId, scopes, hashApiKeyToken(token), token.slice(0, 14)]
    );
    return { authorization: `Bearer ${token}` };
  }

  // Frischer Stand je Testfall: Workspaces, Boards, Quellen mit eingeschaltetem
  // Zurückschreiben.
  async function seed({ push = true } = {}) {
    await cleanup();
    Object.assign(process.env, {
      LEGACY_EMAIL_FROM: LEGACY_FROM, EMAIL_FROM: ROADLIGHT_FROM, RESEND_API_KEY: 're_test',
    });
    fake.reset();
    fake.seed('apps', LEGACY_APP, { name: 'Altes Board', slug: 'alt' });
    await query(
      `insert into tenants (id, name, slug, status, plan) values
         ($1, 'Intern', $2, 'private', 'pro'), ($3, 'Acme', $4, 'active', 'pro')`,
      [INTERN, SLUG[INTERN], ACME, SLUG[ACME]]
    );
    for (const role of ROLES) {
      await query('insert into users (id, email, display_name) values ($1, $2, $3)',
        [userId(role), consoleMail(role), role]);
      await query(
        `insert into sessions (id, user_id, token_hash, expires_at)
         values ($1, $2, $3, now() + interval '1 day')`,
        [`${userId(role)}_s`, userId(role), buildInviteTokenHash(sessionToken(role))]
      );
      for (const tenantId of TENANTS) {
        await query('insert into memberships (id, tenant_id, user_id, role) values ($1, $2, $3, $4)',
          [`${tenantId}_${role}`, tenantId, userId(role), role]);
      }
    }
    for (const board of Object.values(BOARDS)) {
      await query('insert into apps (id, tenant_id, name, slug, ticket_prefix) values ($1, $2, $3, $4, $5)',
        [board.id, INTERN, `Board ${board.slug}`, board.slug, board.prefix]);
    }
    for (const [id, slug] of [[SOURCE_APP, 'board'], [OTHER_APP, 'zweites']]) {
      await query(
        `insert into apps (id, tenant_id, name, slug, ticket_prefix) values ($1, $2, 'Quelle', $3, 'ACM')`,
        [id, ACME, slug]
      );
    }
    sources = {
      alt: await repos.feedback.upsertSource({
        tenantId: INTERN, appId: BOARDS.alt.id, sourceKind: 'legacy', sourceAppId: LEGACY_APP,
      }),
      neu: await repos.feedback.upsertSource({
        tenantId: INTERN, appId: BOARDS.neu.id, sourceKind: 'workspace',
        sourceTenantId: ACME, sourceAppId: SOURCE_APP,
      }),
    };
    if (push) await switchPush(true);
    keys = {
      full: await seedKey(INTERN, API_KEY_SCOPES),
      noStatus: await seedKey(INTERN, API_KEY_SCOPES.filter((scope) => scope !== 'suggestions:status')),
      acme: await seedKey(ACME, API_KEY_SCOPES),
    };
    fake.readLog.length = 0;
    fake.writeLog.length = 0;
    logged.length = 0;
  }

  async function switchPush(enabled) {
    for (const source of Object.values(sources)) await repos.feedback.setPushEnabled(source.id, enabled);
  }

  // Öffentlicher Eintrag im Altbestand.
  function legacyEntry(fields = {}) {
    number += 1;
    const id = `fbpushapi_leg${number}`;
    const data = {
      appId: LEGACY_APP, type: 'bug', title: `Öffentlich ${number}`, description: 'Öffentlicher Text',
      status: 'offen', tag: 'neu', approved: true, ...fields,
    };
    for (const [key, value] of Object.entries(data)) if (value === undefined) delete data[key];
    fake.seed('suggestions', id, data);
    return id;
  }

  // Öffentlicher Eintrag im Quell-Workspace.
  async function workspaceEntry(fields = {}) {
    number += 1;
    const id = `test_fbpushapi_ws${number}`;
    const entry = {
      tenantId: ACME, appId: SOURCE_APP, type: 'bug', title: `Öffentlich ${number}`,
      description: 'Öffentlicher Text', status: 'offen', approved: true, approvedAt: new Date(),
      userFingerprint: FINGERPRINT, ...fields,
    };
    await repos.suggestions.create({ id, ...entry });
    return id;
  }

  // Internes Ticket mit Verknüpfung zu einem öffentlichen Eintrag.
  async function pair({ kind = 'alt', entry = {}, ticket = {}, entryId } = {}) {
    const publicId = entryId || (kind === 'alt' ? legacyEntry(entry) : await workspaceEntry(entry));
    number += 1;
    const id = `test_fbpushapi_ticket${number}`;
    await repos.suggestions.create({
      id, tenantId: INTERN, appId: BOARDS[kind].id, type: 'ticket', title: `Intern ${number}`,
      description: 'Interner Text', status: 'offen', approved: true, approvedAt: new Date(),
      userFingerprint: 'api:feedback', ...ticket,
    });
    await repos.feedback.linkSuggestion({ tenantId: INTERN, suggestionId: id, entryId: publicId });
    return { id, entryId: publicId, kind };
  }

  const as = (role) => ({ 'x-user-session': sessionToken(role) });
  const asPassword = { authorization: 'Bearer test-admin-password' };
  const base = (tenantId = INTERN) => `/api/admin/tenants/${SLUG[tenantId]}`;
  const post = (url, body, headers) => server.request(url, { method: 'POST', body, headers });

  const setStatus = (item, status, headers = as('owner')) => server.request(
    `${base()}/suggestions/${item.id}/status`, { method: 'PUT', body: { status }, headers }
  );
  const patchStatus = (item, status, headers = keys.full) => server.request(
    `/api/v1/suggestions/${item.id}`, { method: 'PATCH', body: { status }, headers }
  );
  const linkUrl = (item, action) => `${base()}/feedback/links/${item.id}/${action}`;
  const publish = (item, status, mail = false, headers = as('owner')) => (
    post(linkUrl(item, 'publish'), { entryId: item.entryId, status, mail }, headers)
  );
  const discard = (item, headers = as('owner')) => (
    post(linkUrl(item, 'discard'), { entryId: item.entryId }, headers)
  );
  const consoleTest = (item, headers = as('owner')) => post(linkUrl(item, 'test'), {}, headers);
  const apiTest = (item, headers = keys.full) => (
    post(`/api/v1/suggestions/${item.id}/public-test`, undefined, headers)
  );
  const ok = (res) => {
    assert.equal(res.status, 200, res.text);
    return res.body;
  };

  const linkRow = async (item) => (await rows(
    'select * from feedback_links where suggestion_id = $1', [item.id]
  ))[0];
  const pending = async (item) => {
    const link = await linkRow(item);
    return [link.pending_status, link.pending_reason, link.pending_mail];
  };
  const NOTHING_PENDING = [null, null, false];
  const legacyDoc = (id) => ({ ...fake.records('suggestions').get(id) });
  const workspaceRow = async (id) => (await rows('select * from suggestions where id = $1', [id]))[0];
  const publicStatus = async (item) => (item.kind === 'alt'
    ? legacyDoc(item.entryId).status
    : (await workspaceRow(item.entryId)).status);
  const writes = (collection) => fake.writeLog.filter((entry) => entry.collection === collection);
  const sourceActivity = () => rows(
    'select * from activity where tenant_id = $1 order by created_at', [ACME]
  );
  const ticketStatus = async (item) => (await workspaceRow(item.id)).status;

  // Merkt sich, was die App ins Log schreibt, und hält die Ausgabe leise.
  async function captureLog(work) {
    const original = { log: console.log, warn: console.warn, error: console.error };
    for (const name of Object.keys(original)) {
      console[name] = (...parts) => logged.push(parts.map((part) => (
        part instanceof Error ? `${part.message} ${part.stack}` : JSON.stringify(part)
      )).join(' '));
    }
    try {
      return await work();
    } finally {
      Object.assign(console, original);
    }
  }

  await t.test('keine Mail ohne Klick', async () => {
    await seed();
    fake.seed('userSettings', 'u1', {
      userFingerprint: FINGERPRINT, notificationsEnabled: true, email: SETTINGS_RECIPIENT,
    });
    const items = [];
    const make = async (options) => {
      const item = await pair(options);
      items.push(item);
      return item;
    };
    const answers = [];
    // Jeder Weg, der intern den Status wechselt, mit Eintrag samt Benachrichtigung.
    for (const headers of [as('owner'), as('admin'), asPassword]) {
      const item = await make({ entry: NOTIFY });
      answers.push(ok(await setStatus(item, 'gelöst', headers)).publicPush);
    }
    const viaKey = await make({ entry: NOTIFY });
    answers.push(ok(await patchStatus(viaKey, 'gelöst')).publicPush);
    const viaSettings = await make({ entry: { userFingerprint: FINGERPRINT } });
    answers.push(ok(await patchStatus(viaSettings, 'gelöst')).publicPush);
    const testing = [];
    for (const run of [apiTest, consoleTest, (item) => consoleTest(item, asPassword)]) {
      const item = await make({ entry: NOTIFY, ticket: { status: 'im Test' } });
      testing.push(item);
      answers.push(ok(await run(item)).publicPush);
    }
    // Holen und Verknüpfen schreiben öffentlich nie.
    await query('update feedback_sources set fetch_enabled = true where tenant_id = $1', [INTERN]);
    ok(await post(`${base()}/feedback/fetch`, {}, as('owner')));

    assert.equal(fake.sentMails.length, 0);
    for (const item of items) {
      assert.deepEqual(await pending(item), [testing.includes(item) ? 'im Test' : 'gelöst', 'mail', true]);
    }
    assert.deepEqual(writes('suggestions'), []);
    assert.deepEqual(writes('activity'), []);
    assert.ok(answers.every((answer) => answer.result === 'waiting' && answer.message === PUSH_MESSAGES.waitingMail),
      JSON.stringify(answers));

    // Gegenprobe: Derselbe Aufbau mit Klick verschickt genau eine Mail.
    const clicked = ok(await publish(items[0], 'gelöst', true));
    assert.equal(clicked.result, 'published', JSON.stringify(clicked));
    assert.equal(fake.sentMails.length, 1);
  });

  await t.test('Klick ohne Sitzung schickt nichts', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    const before = await linkRow(item);

    const callers = [
      ['Admin-Passwort', asPassword, 403],
      ['API-Schlüssel', keys.full, 401],
      ['Admin-Mitglied', as('admin'), 403],
      ['Viewer', as('viewer'), 403],
      ['niemand', {}, 401],
    ];
    const answered = [];
    for (const [who, headers] of callers) {
      for (const call of [() => publish(item, 'gelöst', true, headers), () => discard(item, headers)]) {
        answered.push([who, (await call()).status]);
      }
    }

    assert.equal(fake.sentMails.length, 0);
    assert.deepEqual(answered, callers.flatMap(([who, , status]) => [[who, status], [who, status]]));
    assert.deepEqual(writes('suggestions'), []);
    assert.deepEqual(await linkRow(item), before);
  });

  await t.test('Owner-Klick schreibt und mailt einmal', async () => {
    await seed();
    const item = await pair({ entry: { ...NOTIFY, title: 'Absturz beim Start' } });
    ok(await setStatus(item, 'gelöst'));

    const responses = await Promise.all(Array.from({ length: 5 }, () => publish(item, 'gelöst', true)));

    const results = responses.map((res) => ok(res).result).sort();
    assert.deepEqual(results, ['busy', 'busy', 'busy', 'busy', 'published'], results.join());
    assert.deepEqual(writes('suggestions'), [{ collection: 'suggestions', id: item.entryId, op: 'update' }]);
    assert.equal(writes('activity').length, 1);
    const doc = legacyDoc(item.entryId);
    assert.deepEqual([doc.status, doc.tag, doc.approved], ['gelöst', 'behoben', true]);
    assert.ok(doc.tagUpdatedAt);
    const [activity] = [...fake.records('activity').values()];
    assert.deepEqual(
      { ...activity, createdAt: Boolean(activity.createdAt) },
      {
        tenantId: 'legacy', ticketId: item.entryId, action: 'status_changed', oldValue: 'offen',
        newValue: 'gelöst', detail: 'Status geändert: offen → gelöst', actor: 'admin', createdAt: true,
      }
    );
    assert.equal(fake.sentMails.length, 1);
    const [mail] = fake.sentMails;
    assert.deepEqual([mail.from, mail.to], [LEGACY_FROM, RECIPIENT]);
    assert.equal(mail.subject, 'Ihr Bug "Absturz beim Start" - Status aktualisiert');
    assert.ok(mail.html.includes(`href="https://votingtool.benkohler.de/#suggestion-${item.entryId}"`));
    assert.deepEqual(await pending(item), NOTHING_PENDING);
    const link = await linkRow(item);
    assert.deepEqual([link.push_claim, link.public_status, link.pushed_status], [null, 'gelöst', 'gelöst']);
    // Die Antwort bringt den neuen Stand mit, ohne Adresse.
    const winner = responses.find((res) => res.body.result === 'published');
    const state = winner.body.state.links.find((entry) => entry.suggestionId === item.id);
    assert.deepEqual([state.publicStatus, state.pendingStatus, state.pushEnabled], ['gelöst', null, true]);
    for (const res of responses) assert.equal(res.text.includes(RECIPIENT), false);

    const again = ok(await publish(item, 'gelöst', true));
    assert.equal(again.result, 'busy');
    assert.equal(again.message, PUSH_MESSAGES.nothingPending);
    assert.equal(fake.sentMails.length, 1);
  });

  await t.test('ohne Mail sofort', async () => {
    await seed();
    const bug = await pair({});
    const feature = await pair({ entry: { type: 'feature', status: 'wird geprüft', tag: 'wird geprüft' } });

    const first = ok(await setStatus(bug, 'in Bearbeitung'));
    const second = ok(await patchStatus(feature, 'in Bearbeitung'));

    assert.equal(first.publicPush.result, 'written', JSON.stringify(first));
    assert.equal(first.success, true);
    assert.equal(second.publicPush.result, 'written', JSON.stringify(second));
    assert.equal(second.status, 'in Bearbeitung');
    assert.deepEqual(
      [legacyDoc(bug.entryId).status, legacyDoc(bug.entryId).tag],
      ['in Bearbeitung', 'in analyse']
    );
    assert.deepEqual(
      [legacyDoc(feature.entryId).status, legacyDoc(feature.entryId).tag],
      ['wird umgesetzt', 'wird umgesetzt']
    );
    assert.deepEqual(
      [...fake.records('activity').values()].map((entry) => entry.detail),
      ['Status geändert: offen → in Bearbeitung', 'Status geändert: wird geprüft → wird umgesetzt']
    );
    assert.equal(fake.sentMails.length, 0);
    for (const item of [bug, feature]) assert.deepEqual(await pending(item), NOTHING_PENDING);
  });

  await t.test('Status ohne öffentliche Entsprechung verwirft die wartende Änderung', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));

    const res = ok(await setStatus(item, 'wartend'));

    assert.equal(res.publicPush, undefined);
    assert.deepEqual(await pending(item), NOTHING_PENDING);
    assert.deepEqual(writes('suggestions'), []);
  });

  await t.test('unveränderter Status stößt nichts an', async () => {
    await seed();
    const item = await pair({ ticket: { status: 'gelöst' } });

    for (const res of [await setStatus(item, 'gelöst'), await patchStatus(item, 'gelöst')]) {
      assert.equal(ok(res).publicPush, undefined);
    }
    ok(await server.request(`/api/v1/suggestions/${item.id}`, {
      method: 'PATCH', body: { priority: 'hoch' }, headers: keys.full,
    }));

    assert.equal(fake.readLog.includes('suggestions'), false);
    assert.deepEqual(await pending(item), NOTHING_PENDING);
  });

  await t.test('nicht freigegeben bleibt unberührt', async () => {
    await seed();
    const item = await pair({ entry: { approved: false, status: 'neu' } });
    const later = await pair({});
    await query('update feedback_sources set fetch_enabled = true where tenant_id = $1', [INTERN]);
    ok(await post(`${base()}/feedback/fetch`, {}, as('owner')));
    assert.equal((await linkRow(later)).public_approved, true);
    // Erst nach dem Holen zurückgezogen: Es zählt das frische Lesen.
    fake.records('suggestions').get(later.entryId).approved = false;

    for (const current of [item, later]) {
      const before = legacyDoc(current.entryId);
      const res = ok(await setStatus(current, 'gelöst'));

      assert.deepEqual(res.publicPush, { result: 'error', message: PUSH_MESSAGES.notApproved });
      assert.deepEqual(await pending(current), ['gelöst', 'failed', false]);
      assert.equal((await linkRow(current)).pending_error, PUSH_MESSAGES.notApproved);
      for (const mail of [false, true]) {
        const clicked = ok(await publish(current, 'gelöst', mail));
        assert.equal(clicked.result, 'error');
        assert.equal(clicked.message, PUSH_MESSAGES.notApproved);
      }
      assert.deepEqual(legacyDoc(current.entryId), before);
    }
    assert.deepEqual(writes('suggestions'), []);
    assert.deepEqual(writes('activity'), []);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('fremder Eintrag', async () => {
    await seed();
    fake.seed('apps', 'fbpushapi_other_app', { name: 'Andere App' });
    const legacy = [
      ['andere App', await pair({ entry: { ...NOTIFY, appId: 'fbpushapi_other_app' } })],
      ['fremder Tenant', await pair({ entry: { ...NOTIFY, tenantId: 'anderer' } })],
      ['gelöscht', await pair({ entryId: 'fbpushapi_gibtsnicht' })],
    ];
    const workspace = [
      ['anderes Board', await pair({ kind: 'neu', entry: { appId: OTHER_APP } })],
      ['anderer Workspace', await pair({ kind: 'neu', entry: { tenantId: INTERN, appId: BOARDS.alt.id } })],
      ['gelöschter Eintrag', await pair({ kind: 'neu', entryId: 'test_fbpushapi_gibtsnicht' })],
    ];
    const before = {
      firestore: structuredClone(fake.dump()),
      postgres: await rows(
        `select * from suggestions where tenant_id = $1 or id = any($2) order by id`,
        [ACME, workspace.map(([, item]) => item.entryId)]
      ),
    };

    for (const [name, item] of [...legacy, ...workspace]) {
      const res = ok(await setStatus(item, 'gelöst'));
      assert.deepEqual(res.publicPush, { result: 'error', message: PUSH_MESSAGES.gone }, name);
      for (const mail of [false, true]) {
        assert.equal(ok(await publish(item, 'gelöst', mail)).result, 'error', name);
      }
    }

    assert.deepEqual(fake.dump(), before.firestore);
    assert.deepEqual(await rows(
      `select * from suggestions where tenant_id = $1 or id = any($2) order by id`,
      [ACME, workspace.map(([, item]) => item.entryId)]
    ), before.postgres);
    assert.deepEqual(await sourceActivity(), []);
    assert.equal(fake.sentMails.length, 0);
  });

  for (const hidden of [{ publicHidden: true }, { tenantId: 'anderer' }]) {
    await t.test(`ausgeblendetes Board im Altbestand (${Object.keys(hidden)[0]}) bleibt unberührt`, async () => {
      await seed();
      const item = await pair({ entry: NOTIFY });
      fake.seed('apps', LEGACY_APP, { name: 'Altes Board', ...hidden });

      const res = ok(await setStatus(item, 'gelöst'));

      assert.deepEqual(res.publicPush, { result: 'error', message: PUSH_MESSAGES.boardUnavailable });
      assert.equal(ok(await publish(item, 'gelöst', true)).result, 'error');
      assert.deepEqual(writes('suggestions'), []);
      assert.equal(fake.sentMails.length, 0);
    });
  }

  for (const status of ['suspended', 'private']) {
    await t.test(`Quell-Workspace ${status} wird nicht beschrieben`, async () => {
      await seed();
      const item = await pair({ kind: 'neu', entry: NOTIFY });
      await query('update tenants set status = $2 where id = $1', [ACME, status]);
      const before = await workspaceRow(item.entryId);

      const res = ok(await setStatus(item, 'gelöst'));

      assert.deepEqual(res.publicPush, { result: 'error', message: PUSH_MESSAGES.sourceInactive });
      assert.equal(ok(await publish(item, 'gelöst', true)).result, 'error');
      assert.deepEqual(await workspaceRow(item.entryId), before);
      assert.equal(fake.sentMails.length, 0);
    });
  }

  await t.test('Rückschritt wartet', async () => {
    await seed();
    const item = await pair({ entry: { status: 'gelöst', tag: 'behoben' } });

    const res = ok(await setStatus(item, 'in Bearbeitung'));

    assert.deepEqual(res.publicPush, { result: 'waiting', message: PUSH_MESSAGES.waitingBackward });
    assert.deepEqual(await pending(item), ['in Bearbeitung', 'backward', false]);
    assert.deepEqual(writes('suggestions'), []);
    const clicked = ok(await publish(item, 'in Bearbeitung'));
    assert.deepEqual([clicked.result, clicked.message], ['published_no_mail', undefined]);
    assert.equal(legacyDoc(item.entryId).status, 'in Bearbeitung');
    assert.deepEqual(await pending(item), NOTHING_PENDING);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('alte Einträge nur mit Kennzeichen', async () => {
    await seed();
    const tagOnly = (type, tag) => pair({ entry: { type, tag, status: undefined } });
    // „in analyse“ kann auch „im Test“ sein: kein stiller Rückschritt.
    const testing = await tagOnly('feature', 'im Test');
    ok(await setStatus(testing, 'in Bearbeitung'));
    assert.deepEqual(await pending(testing), ['wird umgesetzt', 'backward', false]);
    const analysed = await tagOnly('bug', 'in analyse');
    ok(await setStatus(analysed, 'in Bearbeitung'));
    assert.deepEqual(await pending(analysed), NOTHING_PENDING);
    assert.deepEqual(writes('suggestions'), []);
    // Vorwärts geht es sofort.
    ok(await setStatus(analysed, 'gelöst'));
    assert.equal(legacyDoc(analysed.entryId).status, 'gelöst');
  });

  await t.test('Typ erst beim Lesen bekannt', async () => {
    await seed();
    // Von Hand verknüpft und nie geholt: Dass es ein Feature ist, zeigt erst die Quelle.
    const item = await pair({ entry: { type: 'feature', status: 'wird geprüft', tag: 'wird geprüft' } });
    const waiting = await pair({ entry: { type: 'feature', status: 'wird geprüft', ...NOTIFY } });

    ok(await setStatus(item, 'gelöst'));
    ok(await setStatus(waiting, 'gelöst'));

    assert.equal(legacyDoc(item.entryId).status, 'ist umgesetzt');
    assert.deepEqual(await pending(item), NOTHING_PENDING);
    assert.deepEqual(await pending(waiting), ['ist umgesetzt', 'mail', true]);
  });

  await t.test('ein Klick gilt nur für den Status, den er nennt', async () => {
    await seed();
    // Von Hand verknüpft, die Quelle beim ersten Versuch nicht lesbar: Es wartet
    // die Ticket-Fassung, obwohl der Eintrag ein Feature ist.
    const item = await pair({ entry: { type: 'feature', status: 'wird geprüft' } });
    const restore = fake.failReads('suggestions');
    ok(await captureLog(() => setStatus(item, 'gelöst')));
    restore();
    assert.deepEqual(await pending(item), ['gelöst', 'failed', false]);

    const first = ok(await publish(item, 'gelöst'));

    assert.deepEqual([first.result, first.message], ['error', PUSH_MESSAGES.changed]);
    assert.deepEqual(await pending(item), ['ist umgesetzt', 'busy', false]);
    assert.equal((await linkRow(item)).push_claim, null);
    assert.deepEqual(writes('suggestions'), []);
    assert.equal(ok(await publish(item, 'ist umgesetzt')).result, 'published_no_mail');
    assert.equal(legacyDoc(item.entryId).status, 'ist umgesetzt');
  });

  await t.test('ohne Absender keine Mail', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    const silent = await pair({});
    ok(await setStatus(item, 'gelöst'));
    process.env.LEGACY_EMAIL_FROM = '';

    const res = ok(await publish(item, 'gelöst', true));

    assert.deepEqual([res.result, res.message], ['error', PUSH_MESSAGES.noLegacySender]);
    assert.deepEqual(writes('suggestions'), []);
    assert.equal(fake.sentMails.length, 0);
    assert.deepEqual(await pending(item), ['gelöst', 'mail', true]);
    assert.equal((await linkRow(item)).pending_error, PUSH_MESSAGES.noLegacySender);
    assert.equal((await linkRow(item)).push_claim, null);

    process.env.RESEND_API_KEY = '';
    process.env.LEGACY_EMAIL_FROM = LEGACY_FROM;
    const unconfigured = ok(await publish(item, 'gelöst', true));
    assert.deepEqual([unconfigured.result, unconfigured.message], ['error', PUSH_MESSAGES.noMailSetup]);
    assert.deepEqual(writes('suggestions'), []);

    // Ohne Empfänger geht es auch ohne Absender und Schlüssel.
    process.env.LEGACY_EMAIL_FROM = '';
    ok(await setStatus(silent, 'gelöst'));
    assert.equal(legacyDoc(silent.entryId).status, 'gelöst');

    // Workspace-Einträge mailen mit EMAIL_FROM.
    process.env.RESEND_API_KEY = 're_test';
    const workspace = await pair({ kind: 'neu', entry: NOTIFY });
    ok(await setStatus(workspace, 'gelöst'));
    assert.equal(ok(await publish(workspace, 'gelöst', true)).result, 'published');
    assert.deepEqual(fake.sentMails.map((mail) => mail.from), [ROADLIGHT_FROM]);
  });

  for (const [how, failure] of [
    ['meldet error', { message: `rate limit für ${RECIPIENT} RESEND-INTERN` }],
    ['wirft', new Error(`getaddrinfo ${RECIPIENT} RESEND-INTERN`)],
  ]) {
    await t.test(`Mail scheitert nach dem Schreiben (Resend ${how})`, async () => {
      await seed();
      const item = await pair({ entry: NOTIFY });
      ok(await setStatus(item, 'gelöst'));
      fake.failMails(failure);

      const res = await captureLog(() => publish(item, 'gelöst', true));

      assert.deepEqual([ok(res).result, res.body.message], ['published_no_mail', PUSH_MESSAGES.mailFailed]);
      assert.equal(legacyDoc(item.entryId).status, 'gelöst');
      assert.deepEqual(await pending(item), NOTHING_PENDING);
      const link = await linkRow(item);
      assert.deepEqual([link.pending_error, link.push_claim], [PUSH_MESSAGES.mailFailed, null]);
      // Keine Wiederholung.
      ok(await publish(item, 'gelöst', true));
      ok(await setStatus(item, 'gelöst'));
      assert.equal(fake.sentMails.length, 1);
      // Weder Adresse noch Fehlertext in Postgres, Antwort oder Log.
      assert.ok(logged.length > 0);
      for (const text of [res.text, logged.join('\n'), JSON.stringify(await linkRow(item))]) {
        assert.equal(text.includes(RECIPIENT), false, text);
        assert.equal(text.includes('RESEND-INTERN'), false, text);
      }
    });
  }

  await t.test('Fehler der Quelle bleiben aus Antwort, Datenbank und Log', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    // Die Meldung der Attrappe nennt die Sammlung; so ein Text darf nirgends auftauchen.
    fake.failReads('suggestions');

    const res = await captureLog(() => setStatus(item, 'gelöst'));

    assert.deepEqual(ok(res).publicPush, { result: 'error', message: PUSH_MESSAGES.failed });
    for (const text of [res.text, logged.join('\n'), JSON.stringify(await linkRow(item))]) {
      assert.equal(text.includes('gestört'), false, text);
    }
  });

  await t.test('Mail wartet auch, wenn die Nutzereinstellung nicht lesbar ist', async () => {
    await seed();
    const item = await pair({ entry: { userFingerprint: FINGERPRINT } });
    fake.failReads('userSettings');

    const res = ok(await captureLog(() => setStatus(item, 'gelöst')));

    assert.equal(res.publicPush.result, 'error');
    assert.deepEqual(writes('suggestions'), []);
    assert.deepEqual(await pending(item), ['gelöst', 'failed', false]);
  });

  await t.test('hängender Mailversand', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    const { token } = await repos.feedback.claimPush({
      tenantId: INTERN, suggestionId: item.id, expectStatus: 'gelöst',
    });
    await repos.feedback.markMailing(token);
    await query("update feedback_links set push_claimed_at = now() - interval '1 hour' where suggestion_id = $1",
      [item.id]);

    const res = ok(await publish(item, 'gelöst', true));

    assert.deepEqual([res.result, res.message], ['busy', PUSH_MESSAGES.mailUnclear]);
    assert.equal(res.state.links.find((link) => link.suggestionId === item.id).pushStage, 'mailing');
    assert.equal(fake.sentMails.length, 0);
    assert.deepEqual(writes('suggestions'), []);
    const cleared = ok(await discard(item));
    assert.equal(cleared.success, true);
    const link = await linkRow(item);
    assert.deepEqual([link.pending_status, link.push_claim, link.push_stage], [null, null, null]);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('Verwerfen schreibt und mailt nichts', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));

    const res = ok(await discard(item));

    assert.equal(res.success, true);
    assert.equal(res.state.links.find((link) => link.suggestionId === item.id).pendingStatus, null);
    assert.equal(ok(await discard(item)).success, false);
    assert.equal(ok(await publish(item, 'gelöst', true)).result, 'busy');
    assert.deepEqual(writes('suggestions'), []);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('Klick auf einen veralteten Stand', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));

    // Die Karte zeigt noch „in Bearbeitung“.
    const stale = ok(await publish(item, 'in Bearbeitung', true));
    assert.deepEqual([stale.result, stale.message], ['busy', PUSH_MESSAGES.changed]);
    // Intern wurde auf einem Weg ohne Nachziehen zurückgesetzt.
    await query("update suggestions set status = 'offen' where id = $1", [item.id]);
    const outdated = ok(await publish(item, 'gelöst', true));

    assert.deepEqual([outdated.result, outdated.message], ['error', PUSH_MESSAGES.changed]);
    assert.deepEqual(await pending(item), NOTHING_PENDING);
    assert.deepEqual(writes('suggestions'), []);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('der Eintrag steht beim Klick schon so', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    fake.records('suggestions').get(item.entryId).status = 'gelöst';

    const res = ok(await publish(item, 'gelöst', true));

    assert.deepEqual([res.result, res.message], ['published_no_mail', PUSH_MESSAGES.alreadyPublic]);
    assert.deepEqual(await pending(item), NOTHING_PENDING);
    assert.deepEqual(writes('suggestions'), []);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('Schalter aus', async () => {
    await seed({ push: false });
    const items = [
      await pair({ entry: NOTIFY }),
      await pair({}),
      await pair({ kind: 'neu' }),
      await pair({ ticket: { status: 'im Test' } }),
    ];
    const before = await rows('select * from suggestions where tenant_id = $1 order by id', [ACME]);

    for (const item of items.slice(0, 3)) {
      assert.equal(ok(await setStatus(item, 'gelöst')).publicPush, undefined);
      assert.equal(ok(await patchStatus(item, 'in Bearbeitung')).publicPush, undefined);
      const clicked = ok(await publish(item, 'in Bearbeitung', true));
      assert.deepEqual([clicked.result, clicked.message], ['error', PUSH_MESSAGES.pushOff]);
    }
    for (const run of [consoleTest, apiTest]) {
      assert.deepEqual(ok(await run(items[3])).publicPush, { result: 'none', message: PUSH_MESSAGES.pushOff });
    }

    for (const item of items) assert.deepEqual(await pending(item), NOTHING_PENDING);
    assert.equal(fake.readLog.includes('suggestions'), false);
    assert.deepEqual(fake.writeLog.filter((entry) => entry.collection !== 'apiKeys'), []);
    assert.deepEqual(await rows('select * from suggestions where tenant_id = $1 order by id', [ACME]), before);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('Ausschalten nimmt die wartende Änderung mit', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));

    await switchPush(false);

    assert.deepEqual(await pending(item), NOTHING_PENDING);
    assert.equal(ok(await publish(item, 'gelöst', true)).result, 'error');
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('kein Nachholen', async () => {
    await seed({ push: false });
    const item = await pair({});
    const workspace = await pair({ kind: 'neu' });
    ok(await setStatus(item, 'gelöst'));
    ok(await setStatus(workspace, 'gelöst'));

    await switchPush(true);
    await query('update feedback_sources set fetch_enabled = true where tenant_id = $1', [INTERN]);
    ok(await post(`${base()}/feedback/fetch`, {}, as('owner')));

    for (const current of [item, workspace]) {
      assert.equal(await publicStatus(current), 'offen');
      assert.deepEqual(await pending(current), NOTHING_PENDING);
    }
    assert.deepEqual(writes('suggestions'), []);
  });

  await t.test('Im Test nur auf Wunsch', async () => {
    await seed();
    const item = await pair({});
    const second = await pair({ kind: 'neu', entry: { type: 'feature', status: 'wird geprüft' } });
    for (const current of [item, second]) {
      assert.equal(ok(await setStatus(current, 'im Test')).publicPush, undefined);
    }
    assert.deepEqual([await publicStatus(item), await publicStatus(second)], ['offen', 'wird geprüft']);
    assert.deepEqual(writes('suggestions'), []);

    const viaConsole = ok(await consoleTest(item, as('admin')));
    const viaKey = ok(await apiTest(second));

    assert.equal(viaConsole.publicPush.result, 'written', JSON.stringify(viaConsole));
    assert.equal(viaKey.publicPush.result, 'written', JSON.stringify(viaKey));
    assert.deepEqual(Object.keys(viaKey), ['publicPush']);
    assert.equal(viaConsole.state.links.find((link) => link.suggestionId === item.id).publicStatus, 'im Test');
    assert.deepEqual([await publicStatus(item), await publicStatus(second)], ['im Test', 'im Test']);
    assert.equal(legacyDoc(item.entryId).tag, 'in analyse');
    assert.deepEqual(ok(await apiTest(second)).publicPush, { result: 'none', message: PUSH_MESSAGES.alreadyPublic });

    // Nur wer intern „im Test“ ist.
    const open = await pair({});
    for (const run of [consoleTest, apiTest]) {
      assert.deepEqual(ok(await run(open)).publicPush, { result: 'none', message: PUSH_MESSAGES.notInTest });
    }
    assert.equal(await publicStatus(open), 'offen');
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('Rechte für „Im Test veröffentlichen“', async () => {
    await seed();
    const item = await pair({ ticket: { status: 'im Test' } });

    for (const [headers, expected] of [[as('viewer'), 403], [{}, 401], [keys.full, 401]]) {
      assert.equal((await consoleTest(item, headers)).status, expected);
    }
    assert.equal((await apiTest(item, keys.noStatus)).status, 403);
    assert.equal((await apiTest(item, {})).status, 401);
    assert.equal((await apiTest(item, as('owner'))).status, 401);
    // Der Schlüssel eines öffentlichen Workspaces, und ein Ticket außerhalb des eigenen.
    assert.equal((await apiTest(item, keys.acme)).status, 409);
    assert.equal((await apiTest({ id: await workspaceEntry() })).status, 404);
    assert.equal((await apiTest({ id: 'gibtsnicht' })).status, 404);

    assert.deepEqual(writes('suggestions'), []);
    assert.deepEqual(await pending(item), NOTHING_PENDING);
  });

  await t.test('nur private Workspaces', async () => {
    await seed();
    const entryId = await workspaceEntry();
    const refused = { error: 'Verknüpfungen gibt es nur in privaten Workspaces.' };

    for (const [url, headers] of [
      [`${base(ACME)}/feedback/links/${entryId}/publish`, as('owner')],
      [`${base(ACME)}/feedback/links/${entryId}/discard`, as('owner')],
      [`${base(ACME)}/feedback/links/${entryId}/test`, as('owner')],
      [`/api/v1/suggestions/${entryId}/public-test`, keys.acme],
    ]) {
      const res = await post(url, { status: 'gelöst', mail: true }, headers);
      assert.equal(res.status, 409, `${url}: ${res.text}`);
      assert.deepEqual(res.body, refused);
    }
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('interner Text bleibt intern', async () => {
    await seed();
    const secrets = { title: 'GEHEIMTITEL', description: 'GEHEIMBESCHREIBUNG', labels: ['GEHEIMLABEL'] };
    const item = await pair({ entry: NOTIFY, ticket: secrets });
    const workspace = await pair({ kind: 'neu', entry: NOTIFY, ticket: secrets });
    for (const current of [item, workspace]) {
      await repos.comments.create({
        id: `${current.id}_c`, tenantId: INTERN, suggestionId: current.id, text: 'GEHEIMKOMMENTAR',
        authorType: 'admin', approvalStatus: 'approved',
      });
    }
    const before = { doc: legacyDoc(item.entryId), row: await workspaceRow(workspace.entryId) };

    for (const current of [item, workspace]) {
      ok(await setStatus(current, 'gelöst'));
      assert.equal(ok(await publish(current, 'gelöst', true)).result, 'published');
    }

    const changed = (a, b) => Object.keys({ ...a, ...b })
      .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])).sort();
    assert.deepEqual(changed(before.doc, legacyDoc(item.entryId)), ['status', 'tag', 'tagUpdatedAt']);
    assert.deepEqual(changed(before.row, await workspaceRow(workspace.entryId)), ['status', 'tag', 'tag_updated_at']);
    assert.deepEqual(await rows('select * from comments where tenant_id = $1', [ACME]), []);
    const outside = JSON.stringify([
      [...fake.records('activity').values()], await sourceActivity(), fake.sentMails,
      legacyDoc(item.entryId), await workspaceRow(workspace.entryId),
    ]);
    assert.equal(fake.sentMails.length, 2);
    for (const secret of ['GEHEIM', 'Interner Text', consoleMail('owner')]) {
      assert.equal(outside.includes(secret), false, secret);
    }
  });

  for (const kind of ['alt', 'neu']) {
    await t.test(`Empfänger erst beim Klick entdeckt (${kind})`, async () => {
      await seed();
      const item = await pair({ kind, entry: { status: 'gelöst' } });
      ok(await setStatus(item, 'in Bearbeitung'));
      assert.deepEqual(await pending(item), ['in Bearbeitung', 'backward', false]);
      if (kind === 'alt') Object.assign(fake.records('suggestions').get(item.entryId), NOTIFY);
      else await repos.suggestions.update(item.entryId, NOTIFY);
      fake.writeLog.length = 0;

      // Weder der Klick ohne Mail noch ein „mit Mail“, das die Karte nie angeboten hat.
      for (const mail of [true, false]) {
        await query('update feedback_links set pending_mail = false where suggestion_id = $1', [item.id]);
        const res = ok(await publish(item, 'in Bearbeitung', mail));

        assert.deepEqual([res.result, res.message], ['error', PUSH_MESSAGES.mailNeedsClick], String(mail));
        assert.deepEqual(await pending(item), ['in Bearbeitung', 'mail', true]);
        assert.equal(await publicStatus(item), 'gelöst');
        assert.equal(fake.sentMails.length, 0);
      }
      // Die Karte nennt jetzt die Mail; ohne Zustimmung im Klick passiert weiter nichts.
      assert.equal(ok(await publish(item, 'in Bearbeitung', false)).result, 'error');
      assert.equal(ok(await publish(item, 'in Bearbeitung', 'true')).result, 'error');
      assert.equal(fake.sentMails.length, 0);

      assert.equal(ok(await publish(item, 'in Bearbeitung', true)).result, 'published');
      assert.equal(await publicStatus(item), 'in Bearbeitung');
      assert.equal(fake.sentMails.length, 1);
    });
  }

  await t.test('Empfänger inzwischen weg: veröffentlicht ohne Mail', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    fake.records('suggestions').get(item.entryId).notificationEnabled = false;

    const res = ok(await publish(item, 'gelöst', true));

    assert.equal(res.result, 'published_no_mail');
    assert.equal(legacyDoc(item.entryId).status, 'gelöst');
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('Workspace-Quelle', async () => {
    await seed();
    const silent = await pair({ kind: 'neu' });
    const feature = await pair({ kind: 'neu', entry: { type: 'feature', status: 'wird geprüft' } });
    const hidden = await pair({ kind: 'neu', entry: { approved: false, approvedAt: null, status: 'neu' } });
    const back = await pair({ kind: 'neu', entry: { status: 'gelöst' } });
    const mailed = await pair({ kind: 'neu', entry: { ...NOTIFY, title: 'Export fehlt' } });

    ok(await setStatus(silent, 'in Bearbeitung'));
    ok(await patchStatus(feature, 'gelöst'));
    assert.equal(ok(await setStatus(hidden, 'gelöst')).publicPush.message, PUSH_MESSAGES.notApproved);
    ok(await setStatus(back, 'in Bearbeitung'));
    ok(await setStatus(mailed, 'gelöst'));
    for (const headers of [keys.full, asPassword, as('admin')]) {
      assert.ok([401, 403].includes((await publish(mailed, 'gelöst', true, headers)).status));
    }

    assert.equal(fake.sentMails.length, 0);
    assert.deepEqual(
      await Promise.all([silent, feature, hidden, back, mailed].map(publicStatus)),
      ['in Bearbeitung', 'ist umgesetzt', 'neu', 'gelöst', 'offen']
    );
    assert.equal((await workspaceRow(hidden.entryId)).approved, false);
    assert.deepEqual(await pending(mailed), ['gelöst', 'mail', true]);
    assert.deepEqual(await pending(back), ['in Bearbeitung', 'backward', false]);
    const row = await workspaceRow(silent.entryId);
    assert.equal(row.tag, 'in analyse');
    assert.ok(row.tag_updated_at);

    const responses = await Promise.all(Array.from({ length: 5 }, () => publish(mailed, 'gelöst', true)));

    assert.equal(responses.filter((res) => ok(res).result === 'published').length, 1);
    assert.equal(fake.sentMails.length, 1);
    const [mail] = fake.sentMails;
    assert.deepEqual([mail.from, mail.to], [ROADLIGHT_FROM, RECIPIENT]);
    assert.equal(mail.subject, 'Dein Bug "Export fehlt" – Status aktualisiert');
    assert.ok(mail.html.includes(`https://roadlight.example.test/${SLUG[ACME]}/board/t/${mailed.entryId}`));
    const activity = await sourceActivity();
    assert.deepEqual(
      activity.map((entry) => [entry.ticket_id, entry.old_value, entry.new_value, entry.detail, entry.actor]),
      [
        [silent.entryId, 'offen', 'in Bearbeitung', 'Status geändert: offen → in Bearbeitung', 'admin'],
        [feature.entryId, 'wird geprüft', 'ist umgesetzt', 'Status geändert: wird geprüft → ist umgesetzt', 'admin'],
        [mailed.entryId, 'offen', 'gelöst', 'Status geändert: offen → gelöst', 'admin'],
      ]
    );
    // Der Workspace-Weg berührt den Altbestand nicht.
    assert.deepEqual(writes('suggestions'), []);
    assert.deepEqual(writes('activity'), []);
  });

  await t.test('Stand nennt wartende Änderung und Schalter', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));

    const state = ok(await server.request(`${base()}/feedback`, { headers: as('viewer') }));

    assert.deepEqual(state.sources.map((source) => source.pushEnabled), [true, true]);
    const link = state.links.find((entry) => entry.suggestionId === item.id);
    assert.deepEqual(
      [link.pendingStatus, link.pendingReason, link.pendingMail, link.pendingError, link.pushStage, link.pushEnabled],
      ['gelöst', 'mail', true, null, null, true]
    );
    assert.equal('pushClaim' in link, false);
  });

  await t.test('der interne Status steht, auch wenn das Zurückschreiben abbricht', async () => {
    await seed();
    const item = await pair({});
    const original = repos.feedback.findLink;
    repos.feedback.findLink = async () => { throw new Error('Datenbank GEHEIMFEHLER'); };
    let res;
    try {
      res = await captureLog(() => setStatus(item, 'gelöst'));
    } finally {
      repos.feedback.findLink = original;
    }

    assert.deepEqual(ok(res).publicPush, { result: 'error', message: PUSH_MESSAGES.failed });
    assert.equal(await ticketStatus(item), 'gelöst');
    assert.equal(logged.join('\n').includes('GEHEIMFEHLER'), false);
  });
  // Ein Versprechen, das der Testfall selbst erfüllt: Bis dahin hängt die Quelle.
  function gate() {
    let open;
    const closed = new Promise((resolve) => { open = resolve; });
    return { closed, open };
  }
  const until = async (condition, what) => {
    for (let i = 0; i < 400; i += 1) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`nicht eingetreten: ${what}`);
  };
  // Nachlaufendes zu Ende kommen lassen.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  for (const [what, disturb, message] of [
    ['Lesen hängt', (fake_) => fake_.failReads('suggestions', { hang: true }), PUSH_MESSAGES.timeout],
    ['Lesen scheitert', (fake_) => fake_.failReads('suggestions'), PUSH_MESSAGES.failed],
    ['Schreiben hängt', (fake_) => fake_.failWrites('suggestions', { hang: true }), PUSH_MESSAGES.timeout],
    ['Schreiben scheitert', (fake_) => fake_.failWrites('suggestions'), PUSH_MESSAGES.failed],
  ]) {
    await t.test(`interner Status bleibt, wenn die Quelle streikt: ${what}`, { timeout: 30000 }, async () => {
      await seed();
      const item = await pair({});
      const restore = disturb(fake);
      const started = Date.now();
      let res;
      try {
        res = await captureLog(() => setStatus(item, 'gelöst'));
      } finally {
        restore();
      }

      assert.ok(Date.now() - started < 10000, `${Date.now() - started} ms`);
      assert.deepEqual(ok(res).publicPush, { result: 'error', message });
      assert.equal(res.body.success, true);
      assert.equal(await ticketStatus(item), 'gelöst');
      assert.deepEqual(await pending(item), ['gelöst', 'failed', false]);
      const link = await linkRow(item);
      assert.deepEqual([link.pending_error, link.push_claim], [message, null]);
      assert.equal(legacyDoc(item.entryId).status, 'offen');
      assert.equal(fake.sentMails.length, 0);
      // Die Karte bietet die Änderung weiter an.
      assert.equal(ok(await publish(item, 'gelöst')).result, 'published_no_mail');
      assert.equal(legacyDoc(item.entryId).status, 'gelöst');
    });
  }

  await t.test('auch ein Schlüssel bekommt bei hängender Quelle seine Antwort', { timeout: 30000 }, async () => {
    await seed();
    const item = await pair({});
    const restore = fake.failReads('apps', { hang: true });
    try {
      const res = ok(await captureLog(() => patchStatus(item, 'gelöst')));
      assert.equal(res.status, 'gelöst');
      assert.deepEqual(res.publicPush, { result: 'error', message: PUSH_MESSAGES.timeout });
    } finally {
      restore();
    }
  });

  await t.test('was nach der Zeitgrenze weiterläuft, schreibt nicht mehr', { timeout: 30000 }, async () => {
    await seed();
    const item = await pair({});
    const held = gate();
    const restore = fake.failReads('suggestions', { hang: held.closed });
    const res = ok(await captureLog(() => setStatus(item, 'gelöst')));
    restore();
    assert.equal(res.publicPush.message, PUSH_MESSAGES.timeout);
    fake.readLog.length = 0;

    held.open();
    await settle();

    assert.deepEqual(writes('suggestions'), []);
    assert.equal(legacyDoc(item.entryId).status, 'offen');
    assert.deepEqual(await pending(item), ['gelöst', 'failed', false]);
    assert.equal((await linkRow(item)).push_claim, null);
  });

  // Bekannte Grenze: Ein Schreiben, das bei Ablauf schon unterwegs ist, lässt
  // sich nicht zurückholen. Es darf dann aber keine Mail nach sich ziehen.
  await t.test('ein verspätet ankommendes Schreiben mailt nicht', { timeout: 30000 }, async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    const held = gate();
    const restore = fake.failWrites('suggestions', { hang: held.closed });
    const first = ok(await captureLog(() => publish(item, 'gelöst', true)));
    restore();
    assert.deepEqual([first.result, first.message], ['error', PUSH_MESSAGES.timeout]);

    held.open();
    await settle();

    assert.equal(legacyDoc(item.entryId).status, 'gelöst');
    assert.deepEqual(await pending(item), ['gelöst', 'failed', true]);
    assert.equal(fake.sentMails.length, 0);
    const again = ok(await publish(item, 'gelöst', true));
    assert.deepEqual([again.result, again.message], ['published_no_mail', PUSH_MESSAGES.alreadyPublic]);
    assert.deepEqual(await pending(item), NOTHING_PENDING);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('ein verspäteter erster Klick mailt nicht nach dem zweiten', { timeout: 30000 }, async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    const held = gate();
    const restore = fake.failReads('suggestions', { hang: held.closed });
    const first = ok(await captureLog(() => publish(item, 'gelöst', true)));
    restore();
    assert.deepEqual([first.result, first.message], ['error', PUSH_MESSAGES.timeout]);
    assert.deepEqual(await pending(item), ['gelöst', 'failed', true]);

    assert.equal(ok(await publish(item, 'gelöst', true)).result, 'published');
    held.open();
    await settle();

    assert.equal(fake.sentMails.length, 1);
    assert.equal(writes('suggestions').length, 1);
    assert.equal(writes('activity').length, 1);
    assert.deepEqual(await pending(item), NOTHING_PENDING);
  });

  // Zwei Statuswechsel, während der erste an der Quelle hängt.
  for (const [what, disturb, expectedWrites] of [
    ['beim Lesen', (hang) => fake.failReads('suggestions', { hang }), 0],
    ['beim Schreiben', (hang) => fake.failWrites('suggestions', { hang }), 1],
  ]) {
    await t.test(`zweiter Statuswechsel, während der erste ${what} hängt`, async () => {
      await seed();
      const item = await pair({});
      const held = gate();
      const restore = disturb(held.closed);
      const first = setStatus(item, 'in Bearbeitung');
      await until(async () => (await linkRow(item)).push_claim !== null, 'erster Anspruch');
      if (what === 'beim Schreiben') {
        await until(() => fake.readLog.includes('suggestions'), 'Eintrag gelesen');
        await settle();
      }

      const second = ok(await setStatus(item, 'gelöst'));
      held.open();
      const done = ok(await first);
      restore();

      assert.deepEqual(second.publicPush, { result: 'waiting', message: PUSH_MESSAGES.waitingBusy });
      assert.ok(done.publicPush, JSON.stringify(done));
      assert.equal(writes('suggestions').length, expectedWrites);
      assert.deepEqual(await pending(item), ['gelöst', 'busy', false]);
      assert.equal((await linkRow(item)).push_claim, null);
      assert.equal(ok(await publish(item, 'gelöst')).result, 'published_no_mail');
      assert.equal(legacyDoc(item.entryId).status, 'gelöst');
    });
  }

  for (const kind of ['alt', 'neu']) {
    await t.test(`gleichzeitige Statuswechsel: Der letzte interne Stand zählt (${kind})`, async () => {
      await seed();
      const expected = { 'in Bearbeitung': 'in Bearbeitung', 'gelöst': 'gelöst', offen: null };
      const combos = [['in Bearbeitung', 'gelöst'], ['gelöst', 'in Bearbeitung'], ['in Bearbeitung', 'offen']];
      for (let round = 0; round < 12; round += 1) {
        const item = await pair({ kind, ticket: { status: 'neu' } });
        const [a, b] = combos[round % combos.length];
        const before = await publicStatus(item);

        for (const res of await Promise.all([setStatus(item, a), patchStatus(item, b)])) ok(res);

        const internal = await ticketStatus(item);
        const link = await linkRow(item);
        const published = await publicStatus(item);
        const context = JSON.stringify({ round, a, b, internal, pending: link.pending_status, published });
        assert.equal(link.push_claim, null, context);
        if (expected[internal] === null) {
          // Nichts wartet; geschrieben wurde höchstens der Zwischenstand.
          assert.equal(link.pending_status, null, context);
          assert.ok([before, expected[a]].includes(published), context);
        } else if (link.pending_status !== null) {
          assert.equal(link.pending_status, expected[internal], context);
        } else {
          assert.equal(published, expected[internal], context);
        }
      }
      assert.equal(fake.sentMails.length, 0);
    });
  }

  await t.test('Ticket ohne Verknüpfung: Antwort wie bisher, kein Zugriff auf die Quelle', async () => {
    await seed();
    await repos.suggestions.create({
      id: 'test_fbpushapi_frei', tenantId: INTERN, appId: BOARDS.alt.id, type: 'ticket', title: 'Frei',
      status: 'offen', approved: true, approvedAt: new Date(),
    });
    const item = { id: 'test_fbpushapi_frei' };

    assert.deepEqual(ok(await setStatus(item, 'gelöst')), {
      success: true, message: 'Status erfolgreich aktualisiert',
    });
    assert.equal('publicPush' in ok(await patchStatus(item, 'in Bearbeitung')), false);

    assert.deepEqual(fake.readLog, []);
  });
  // Hält das nächste Schreiben in die Quelle an, bis `open()` gerufen wird.
  // `reached` wird erfüllt, sobald es angekommen ist.
  function holdNextWrite(kind) {
    const held = gate();
    if (kind === 'alt') {
      const before = fake.writeAttempts.length;
      const restore = fake.failWrites('suggestions', { hang: held.closed });
      const reached = until(() => fake.writeAttempts.length > before, 'Schreiben begonnen').then(restore);
      return { reached, open: held.open };
    }
    const original = repos.suggestions.updateIfUnchanged;
    let arrived = false;
    repos.suggestions.updateIfUnchanged = async (...args) => {
      repos.suggestions.updateIfUnchanged = original;
      arrived = true;
      await held.closed;
      return original(...args);
    };
    return { reached: until(() => arrived, 'Schreiben begonnen'), open: held.open };
  }

  const activityCount = async (kind) => (kind === 'alt' ? writes('activity').length : (await sourceActivity()).length);
  // Ändert den öffentlichen Eintrag an etwas anderem als dem Status.
  const touch = async (item) => {
    if (item.kind === 'alt') {
      const docs = fake.records('suggestions');
      docs.set(item.entryId, { ...docs.get(item.entryId), votes: 7 });
    } else {
      await query('update suggestions set votes = votes + 1 where id = $1', [item.entryId]);
    }
  };

  for (const kind of ['alt', 'neu']) {
    await t.test(`altes Schreiben kommt nach dem neuen an und scheitert (${kind})`, { timeout: 30000 }, async () => {
      await seed();
      const item = await pair({ kind });
      const old = holdNextWrite(kind);
      const first = ok(await captureLog(() => setStatus(item, 'in Bearbeitung')));
      await old.reached;
      assert.equal(first.publicPush.message, PUSH_MESSAGES.timeout);
      assert.equal(ok(await setStatus(item, 'gelöst')).publicPush.result, 'written');

      old.open();
      await settle();

      assert.equal(await publicStatus(item), 'gelöst');
      assert.deepEqual(await pending(item), NOTHING_PENDING);
      assert.equal((await linkRow(item)).public_status, 'gelöst');
      assert.equal(await activityCount(kind), 1);
      assert.equal(fake.sentMails.length, 0);
    });

    await t.test(`altes Schreiben landet zwischen Lesen und Schreiben des neuen (${kind})`, { timeout: 30000 }, async () => {
      await seed();
      const item = await pair({ kind });
      const old = holdNextWrite(kind);
      ok(await captureLog(() => setStatus(item, 'in Bearbeitung')));
      await old.reached;
      const fresh = holdNextWrite(kind);
      const second = captureLog(() => setStatus(item, 'gelöst'));
      await fresh.reached;
      old.open();
      await settle();
      assert.equal(await publicStatus(item), 'in Bearbeitung');

      fresh.open();
      const res = ok(await second);

      assert.deepEqual(res.publicPush, { result: 'waiting', message: PUSH_MESSAGES.waitingConflict });
      assert.equal(await publicStatus(item), 'in Bearbeitung');
      assert.deepEqual(await pending(item), ['gelöst', 'busy', false]);
      const link = await linkRow(item);
      assert.deepEqual([link.pending_error, link.push_claim], [PUSH_MESSAGES.conflict, null]);
      // Ein Verlaufseintrag nur für das angekommene alte Schreiben, keiner für das abgelehnte neue.
      assert.equal(await activityCount(kind), 1);
      assert.equal(ok(await publish(item, 'gelöst')).result, 'published_no_mail');
      assert.equal(await publicStatus(item), 'gelöst');
      assert.deepEqual(await pending(item), NOTHING_PENDING);
    });

    await t.test(`Eintrag ändert sich zwischen Lesen und Schreiben: Klick schreibt und mailt nicht (${kind})`, async () => {
      await seed();
      const item = await pair({ kind, entry: NOTIFY });
      ok(await setStatus(item, 'gelöst'));
      const held = holdNextWrite(kind);
      const click = captureLog(() => publish(item, 'gelöst', true));
      await held.reached;
      await touch(item);
      held.open();

      const res = ok(await click);

      assert.deepEqual([res.result, res.message], ['busy', PUSH_MESSAGES.conflict]);
      assert.equal(await publicStatus(item), 'offen');
      assert.equal(await activityCount(kind), 0);
      assert.equal(fake.sentMails.length, 0);
      assert.deepEqual(await pending(item), ['gelöst', 'busy', true]);
      assert.equal((await linkRow(item)).push_claim, null);
      // Mit dem frischen Stand geht der nächste Klick durch.
      assert.equal(ok(await publish(item, 'gelöst', true)).result, 'published');
      assert.equal(fake.sentMails.length, 1);
    });
  }

  await t.test('ohne Stand des gelesenen Eintrags wird nicht geschrieben', async () => {
    await seed();
    const item = await pair({});
    fake.hideUpdateTime('suggestions');

    const res = ok(await captureLog(() => setStatus(item, 'gelöst')));

    assert.deepEqual(res.publicPush, { result: 'error', message: PUSH_MESSAGES.failed });
    assert.deepEqual(writes('suggestions'), []);
    assert.deepEqual(await pending(item), ['gelöst', 'failed', false]);
  });

  await t.test('der Klick gilt nur für den Eintrag, den die Karte zeigt', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    const before = await linkRow(item);

    for (const entryId of [undefined, '', 'anderer_eintrag', 7, [item.entryId]]) {
      const clicked = ok(await post(linkUrl(item, 'publish'), { entryId, status: 'gelöst', mail: true }, as('owner')));
      assert.deepEqual([clicked.result, clicked.message], ['busy', PUSH_MESSAGES.changed], JSON.stringify(entryId));
      const discarded = ok(await post(linkUrl(item, 'discard'), { entryId }, as('owner')));
      assert.deepEqual([discarded.success, discarded.message], [false, PUSH_MESSAGES.changed], JSON.stringify(entryId));
    }

    assert.deepEqual(await linkRow(item), before);
    assert.deepEqual(writes('suggestions'), []);
    assert.equal(fake.sentMails.length, 0);
  });

  await t.test('neu verknüpft: Der Klick der alten Karte trifft den neuen Eintrag nicht', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    const other = legacyEntry(NOTIFY);
    await repos.feedback.unlinkSuggestion({ tenantId: INTERN, suggestionId: item.id });
    await repos.feedback.linkSuggestion({ tenantId: INTERN, suggestionId: item.id, entryId: other });
    // Auf dem neuen Eintrag wartet derselbe Status.
    ok(await setStatus(item, 'offen'));
    ok(await setStatus(item, 'gelöst'));
    assert.deepEqual(await pending(item), ['gelöst', 'mail', true]);

    const clicked = ok(await publish(item, 'gelöst', true));
    const discarded = ok(await discard(item));

    assert.deepEqual([clicked.result, clicked.message], ['busy', PUSH_MESSAGES.changed]);
    assert.equal(discarded.success, false);
    assert.deepEqual(await pending(item), ['gelöst', 'mail', true]);
    assert.deepEqual(writes('suggestions'), []);
    assert.equal(fake.sentMails.length, 0);
    // Die neu geladene Karte nennt den neuen Eintrag.
    assert.equal(ok(await publish({ ...item, entryId: other }, 'gelöst', true)).result, 'published');
    assert.equal(legacyDoc(item.entryId).status, 'offen');
    assert.equal(legacyDoc(other).status, 'gelöst');
  });

  // Zwischen Nachsehen und Anspruch neu verknüpft: Der Anspruch selbst prüft den
  // Eintrag.
  await t.test('der Anspruch bindet den Eintrag', async () => {
    await seed();
    const item = await pair({ entry: NOTIFY });
    ok(await setStatus(item, 'gelöst'));
    const ids = { tenantId: INTERN, suggestionId: item.id };

    assert.equal(await repos.feedback.claimPush({ ...ids, expectStatus: 'gelöst', expectEntryId: 'x' }), null);
    assert.equal(await repos.feedback.discardPending({ ...ids, entryId: 'x' }), false);
    assert.ok(await repos.feedback.claimPush({ ...ids, expectStatus: 'gelöst', expectEntryId: item.entryId }));
  });
});
