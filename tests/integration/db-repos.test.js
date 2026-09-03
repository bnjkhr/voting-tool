'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDatabase } = require('./helpers');

const suite = hasDatabase ? test : test.skip;

const T = 'test_r_tenant';
const A = 'test_r_app';
const U = 'test_r_user';
const EMAIL = 'test_r_user@example.com';

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from tenants where id = $1', [T]);      // cascade: apps, suggestions, votes, comments, releases, memberships, invites, api_keys, attachments
  await query('delete from users where id = $1', [U]);         // cascade: sessions
  await query('delete from login_links where email = $1', [EMAIL]);
  await query('delete from activity where tenant_id = $1', [T]);
}

suite('remaining repositories (suggestions, comments, releases, activity, users, memberships, invites, sessions, login-links, api-keys, attachments)', async (t) => {
  const { query } = require('../../db/pool');
  const suggestions = require('../../db/suggestions');
  const apps = require('../../db/apps');
  const comments = require('../../db/comments');
  const releases = require('../../db/releases');
  const activity = require('../../db/activity');
  const users = require('../../db/users');
  const memberships = require('../../db/memberships');
  const invites = require('../../db/invites');
  const sessions = require('../../db/sessions');
  const loginLinks = require('../../db/login-links');
  const apiKeys = require('../../db/api-keys');
  const attachments = require('../../db/attachments');

  t.after(cleanup);
  await cleanup();

  await query(`insert into tenants (id, name, slug) values ($1,'R','${T}')`, [T]);
  await query(`insert into apps (id, tenant_id, name, slug, ticket_prefix) values ($1,$2,'B','board','R')`, [A, T]);

  // --- suggestions ---
  const s = await suggestions.create({ id: 'test_r_s1', tenantId: T, appId: A, type: 'bug', title: 'Crash', severity: 'high', environment: { platform: 'iOS' } });
  assert.equal(s.type, 'bug');
  assert.deepEqual(s.environment, { platform: 'iOS' });          // jsonb round-trip
  assert.equal((await suggestions.listPublicForApp(A)).length, 0); // noch nicht approved
  await suggestions.setApproved('test_r_s1');
  assert.equal((await suggestions.listPublicForApp(A)).length, 1);
  const labelled = await suggestions.addLabel('test_r_s1', 'ui');
  assert.deepEqual(labelled.labels, ['ui']);
  await suggestions.addLabel('test_r_s1', 'ui');                  // dedup
  assert.deepEqual((await suggestions.findById('test_r_s1')).labels, ['ui']);
  await suggestions.removeLabel('test_r_s1', 'ui');
  assert.deepEqual((await suggestions.findById('test_r_s1')).labels, []);
  assert.equal((await suggestions.listByAppFiltered(A, T)).length, 1);
  assert.equal((await suggestions.listByAppFiltered(A, 'other-tenant')).length, 0); // tenant-gescopt

  // v1 POST /apps/:slug/suggestions legt direkt freigegeben an. approved ohne
  // approved_at wäre eine halbfertige Zeile (Sortierung/Audit); das Repo
  // stempelt den Zeitstempel deshalb selbst, wenn keiner mitkommt.
  const viaApi = await suggestions.create({
    id: 'test_r_s2', tenantId: T, appId: A, type: 'feature',
    title: 'Via API', approved: true, ticketNumber: 'R-002',
  });
  assert.equal(viaApi.approved, true);
  assert.ok(viaApi.approvedAt, 'approved-Create muss approved_at setzen');
  const stamped = await suggestions.create({
    id: 'test_r_s3', tenantId: T, appId: A, type: 'feature',
    title: 'Mit Zeitstempel', approved: true, approvedAt: new Date('2026-01-02T03:04:05Z'),
  });
  assert.equal(stamped.approvedAt.toISOString(), '2026-01-02T03:04:05.000Z',
    'ein übergebener Zeitstempel wird übernommen');
  assert.equal(
    (await suggestions.create({ id: 'test_r_s4', tenantId: T, appId: A, type: 'feature', title: 'Offen' })).approvedAt,
    null,
    'nicht freigegebene Einträge bekommen keinen approved_at-Zeitstempel'
  );

  // created_at: der Import bringt das historische Einreichungsdatum mit. Ohne
  // die Spalte im Insert fiel es still auf now() zurück — also genau das Datum
  // verloren, das der Import retten soll.
  const imported = await suggestions.create({
    id: 'test_r_s5', tenantId: T, appId: A, type: 'feature',
    title: 'Importiert', approved: true, ticketNumber: 'R-140',
    createdAt: new Date('2026-04-30T09:12:00Z'),
  });
  assert.equal(imported.createdAt.toISOString(), '2026-04-30T09:12:00.000Z',
    'ein übergebenes created_at wird übernommen');
  const fresh = await suggestions.create({
    id: 'test_r_s6', tenantId: T, appId: A, type: 'feature', title: 'Frisch',
  });
  assert.ok(fresh.createdAt, 'ohne created_at greift der Spalten-Default now()');
  assert.ok(fresh.createdAt > imported.createdAt, 'der Default ist die Gegenwart, nicht das Importdatum');

  // --- Ticketnummer: eindeutig je Board (migration 0007) ---
  // Der vorgelagerte SELECT in createWithImportedTicketNumber ist ein
  // Check-then-Insert und traegt unter Nebenlaeufigkeit nicht. Diese Faelle
  // treffen den echten Failure Mode: erst den regulaeren Weg, dann das Rennen.
  const imp = { appId: A, tenantId: T, ticketNumber: 'R-500', ticketNumberValue: 500 };
  const first = await suggestions.createWithImportedTicketNumber({
    ...imp, data: { id: 'test_r_imp1', tenantId: T, appId: A, type: 'feature', title: 'Import 1' },
  });
  assert.ok(first.row, 'erster Import legt an');
  assert.equal(first.row.ticketNumber, 'R-500');
  assert.equal((await apps.findById(A)).nextTicketNumber >= 501, true, 'Zaehler wurde auf 501 gehoben');

  // Sequenziell: der SELECT sieht die committete Zeile -> sauberer conflict.
  const second = await suggestions.createWithImportedTicketNumber({
    ...imp, data: { id: 'test_r_imp2', tenantId: T, appId: A, type: 'feature', title: 'Import 2' },
  });
  assert.equal(second.conflict, true, 'zweiter Import derselben Nummer ist ein Konflikt');
  assert.equal(second.row, undefined);

  // Nebenlaeufigkeit deterministisch statt per Promise.all: zwei Verbindungen
  // werden von Hand so verschraenkt, wie zwei gleichzeitige Importe laufen.
  // Ein Promise.all-Test war hier zuerst drin und blieb auch OHNE Index gruen —
  // die Transaktionen serialisierten sich zufaellig ueber den Row-Lock auf
  // apps. Ein Test, der vor dem Fix nicht rot wird, prueft das Falsche.
  const { getPool } = require('../../db/pool');
  const c1 = await getPool().connect();
  const c2 = await getPool().connect();
  let raced;
  try {
    await c1.query('begin');
    await c2.query('begin');
    // Beide sehen "kein Duplikat" — genau das Fenster, das der SELECT offen laesst.
    const seen1 = await c1.query('select 1 from suggestions where app_id = $1 and ticket_number = $2', [A, 'R-501']);
    const seen2 = await c2.query('select 1 from suggestions where app_id = $1 and ticket_number = $2', [A, 'R-501']);
    assert.equal(seen1.rows.length, 0);
    assert.equal(seen2.rows.length, 0, 'beide Transaktionen halten die Nummer fuer frei');

    await c1.query(
      `insert into suggestions (id, tenant_id, app_id, type, title, ticket_number)
       values ('test_r_race1', $1, $2, 'feature', 'Race 1', 'R-501')`, [T, A]);
    await c1.query('commit');

    // Erst jetzt schreibt der zweite — der SELECT von oben ist laengst veraltet.
    try {
      await c2.query(
        `insert into suggestions (id, tenant_id, app_id, type, title, ticket_number)
         values ('test_r_race2', $1, $2, 'feature', 'Race 2', 'R-501')`, [T, A]);
      await c2.query('commit');
      raced = null;
    } catch (err) {
      await c2.query('rollback');
      raced = err;
    }
  } finally {
    c1.release();
    c2.release();
  }

  assert.ok(raced, 'ohne Unique-Index wuerde der zweite Insert durchgehen und ein Duplikat erzeugen');
  assert.equal(raced.code, '23505', 'die DB weist das Duplikat ab');
  assert.equal(
    suggestions.isTicketNumberConflict(raced), true,
    'createWithImportedTicketNumber erkennt genau diesen Fehler und antwortet mit 409 statt 500'
  );
  // Fremde Constraint-Verletzungen duerfen NICHT als Ticketnummer-Konflikt gelten.
  assert.equal(suggestions.isTicketNumberConflict({ code: '23505', constraint: 'votes_suggestion_id_user_fingerprint_key' }), false);
  assert.equal(suggestions.isTicketNumberConflict({ code: '23503', constraint: 'suggestions_app_ticket_number_uidx' }), false);
  assert.equal(suggestions.isTicketNumberConflict(null), false);

  const stored = await query('select count(*)::int as n from suggestions where app_id = $1 and ticket_number = $2', [A, 'R-501']);
  assert.equal(stored.rows[0].n, 1, 'die DB haelt genau eine Zeile mit R-501');

  // Dieselbe Nummer auf einem ANDEREN Board bleibt erlaubt.
  await apps.create({ id: 'test_r_app2', tenantId: T, name: 'B2', slug: 'board-2', ticketPrefix: 'R' });
  const otherBoard = await suggestions.createWithImportedTicketNumber({
    appId: 'test_r_app2', tenantId: T, ticketNumber: 'R-500', ticketNumberValue: 500,
    data: { id: 'test_r_imp3', tenantId: T, appId: 'test_r_app2', type: 'feature', title: 'Anderes Board' },
  });
  assert.ok(otherBoard.row, 'Ticketnummern sind nur je Board eindeutig, nicht global');

  // Mehrere Zeilen OHNE Nummer bleiben erlaubt (partieller Index).
  await suggestions.create({ id: 'test_r_nonum1', tenantId: T, appId: A, type: 'feature', title: 'ohne Nummer 1' });
  await suggestions.create({ id: 'test_r_nonum2', tenantId: T, appId: A, type: 'feature', title: 'ohne Nummer 2' });

  // --- releases + Verknüpfung ---
  const r = await releases.create({ id: 'test_r_rel', tenantId: T, appId: A, version: '1.0', title: 'Launch' });
  assert.equal(r.status, 'geplant');
  const pub = await releases.setPublished('test_r_rel');
  assert.equal(pub.status, 'veröffentlicht');
  assert.ok(pub.publishedAt);
  assert.equal((await releases.listPublishedByApp(A)).length, 1);
  // listByApp ist tenant-gescopt: app_id allein ist keine Tenant-Grenze, sobald
  // eine releases-Zeile eine von ihrer App abweichende tenant_id traegt.
  assert.equal((await releases.listByApp(A, T)).length, 1);
  assert.equal((await releases.listByApp(A, 'other-tenant')).length, 0, 'fremder Tenant sieht das Release nicht');
  await suggestions.update('test_r_s1', { releaseId: 'test_r_rel' });
  assert.equal((await suggestions.listByRelease('test_r_rel')).length, 1);
  // approved + tenant-gescopt für Roadmap/Changelog
  assert.equal((await suggestions.listApprovedByReleaseIds(['test_r_rel'], T)).length, 1);
  assert.equal((await suggestions.listApprovedByReleaseIds(['test_r_rel'], 'other-tenant')).length, 0);

  // --- comments (Moderation) ---
  const adminC = await comments.create({ id: 'test_r_c1', tenantId: T, suggestionId: 'test_r_s1', text: 'admin', authorType: 'admin', approvalStatus: 'approved' });
  assert.equal(adminC.approvalStatus, 'approved');
  await comments.create({ id: 'test_r_c2', tenantId: T, suggestionId: 'test_r_s1', text: 'user', authorType: 'user' });
  assert.equal((await comments.listApprovedForSuggestion('test_r_s1')).length, 1);
  assert.equal((await comments.listPendingByTenant(T)).length, 1);
  // statsForSuggestions: 1 approved + 1 pending
  const stats = await comments.statsForSuggestions(['test_r_s1'], T);
  assert.deepEqual(stats['test_r_s1'], { totalCount: 2, pendingCount: 1, publicCount: 1 });
  await comments.approve('test_r_c2', 'admin');
  assert.equal((await comments.listApprovedForSuggestion('test_r_s1')).length, 2);
  await comments.reject('test_r_c2', 'admin');
  assert.equal((await comments.findById('test_r_c2')).approvalStatus, 'rejected');

  // --- activity ---
  await activity.log({ tenantId: T, ticketId: 'test_r_s1', action: 'created', detail: 'x', actor: 'admin' });
  assert.equal((await activity.listByTicket('test_r_s1')).length, 1);

  // --- users + memberships ---
  const u = await users.create({ id: U, email: EMAIL, displayName: 'R User' });
  assert.equal((await users.findByEmail(EMAIL.toUpperCase())).id, U); // citext case-insensitive
  const m = await memberships.create({ id: 'test_r_m', tenantId: T, userId: U, role: 'owner' });
  assert.equal(m.role, 'owner');
  assert.equal((await memberships.findByTenantAndUser(T, U)).id, 'test_r_m');
  assert.equal((await memberships.listActiveAdmins(T)).length, 1);
  assert.equal(await memberships.countActiveOwners(T), 1);
  assert.deepEqual(await memberships.adminEmails(T), [EMAIL]); // für Benachrichtigungen
  const withUsers = await memberships.listWithUsers(T);
  assert.equal(withUsers.length, 1);
  assert.equal(withUsers[0].email, EMAIL);
  assert.equal(withUsers[0].displayName, 'R User');
  assert.equal(withUsers[0].role, 'owner');
  await memberships.update('test_r_m', { status: 'disabled', disabledAt: new Date() });
  assert.equal(await memberships.countActiveOwners(T), 0);
  assert.deepEqual(await memberships.adminEmails(T), []); // disabled -> keine Empfänger

  // --- invites ---
  const inv = await invites.create({ id: 'test_r_inv', tenantId: T, email: 'x@example.com', role: 'viewer', tokenHash: 'hash_inv', expiresAt: new Date(Date.now() + 3600e3) });
  assert.equal((await invites.findByTokenHash('hash_inv')).id, 'test_r_inv');
  assert.equal((await invites.findPending(T, 'x@example.com')).id, 'test_r_inv');
  await invites.update('test_r_inv', { status: 'accepted', acceptedAt: new Date() });
  assert.equal((await invites.findByTokenHash('hash_inv')).status, 'accepted');

  // --- sessions ---
  await sessions.create({ id: 'test_r_sess', userId: U, tokenHash: 'hash_sess', expiresAt: new Date(Date.now() + 3600e3) });
  assert.equal((await sessions.findByTokenHash('hash_sess')).id, 'test_r_sess');
  await sessions.touch('test_r_sess');
  await sessions.revoke('test_r_sess');
  assert.equal(await sessions.findByTokenHash('hash_sess'), null); // revoked -> nicht mehr aktiv

  // --- login-links ---
  await loginLinks.create({ id: 'test_r_ll', email: EMAIL, tokenHash: 'hash_ll', redirectUrl: '/x', expiresAt: new Date(Date.now() + 900e3) });
  assert.equal((await loginLinks.findByTokenHash('hash_ll')).id, 'test_r_ll');
  await loginLinks.consume('test_r_ll');
  assert.equal(await loginLinks.findByTokenHash('hash_ll'), null); // consumed -> nicht mehr pending

  // --- api-keys ---
  await apiKeys.create({ id: 'test_r_key', tenantId: T, name: 'K', scopes: ['suggestions:read'], tokenHash: 'hash_key', tokenPrefix: 'vt_live_abc', createdBy: 'admin' });
  assert.equal((await apiKeys.findByTokenHash('hash_key')).id, 'test_r_key');
  assert.deepEqual((await apiKeys.findByTokenHash('hash_key')).scopes, ['suggestions:read']);
  assert.equal((await apiKeys.listByTenant(T)).length, 1);
  // Genau der Lookup, den requireApiKey unter DATA_BACKEND=postgres fährt:
  // Hash rein -> Key mit Tenant/Scopes raus, danach lastUsedAt fortschreiben.
  const authKey = await apiKeys.findByTokenHash('hash_key');
  assert.equal(authKey.tenantId, T, 'Key muss den Tenant für die Scope-/Plan-Prüfung tragen');
  assert.equal(authKey.lastUsedAt, null, 'frischer Key wurde noch nie benutzt');
  const touched = await apiKeys.touch('test_r_key');
  assert.ok(touched.lastUsedAt, 'touch schreibt lastUsedAt fort (Usage-Tracking im v1-Pfad)');
  assert.equal(await apiKeys.findByTokenHash('kein_treffer'), null,
    'unbekannter Hash liefert null -> 401 statt Treffer auf eine Fremdzeile');

  await apiKeys.revoke('test_r_key');
  // revoke löscht nicht — requireApiKey findet den Key weiter und antwortet
  // wegen revokedAt mit 401 'API key revoked' (isApiKeyActive).
  assert.ok((await apiKeys.findByTokenHash('hash_key')).revokedAt);

  // --- attachments (inline bytea + Batch-Load + Proxy-Fetch) ---
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');           // PNG-Magic reicht als Testinhalt
  const [att] = await attachments.createMany([
    { tenantId: T, parentType: 'suggestion', parentId: 'test_r_s1', data: bytes, contentType: 'image/png' },
  ]);
  assert.ok(att.id);                                              // von DB generiert
  assert.equal(att.sizeBytes, bytes.length);                      // size aus data abgeleitet
  assert.equal((await attachments.listForParent('suggestion', 'test_r_s1')).length, 1);

  // Mehrere Bilder eines Parents landen in EINEM Insert (statt einer Runde pro
  // Bild) und behalten Reihenfolge und abgeleitete Grösse.
  const jpg = Buffer.from('ffd8ffe0', 'hex');
  const many = await attachments.createMany([
    { tenantId: T, parentType: 'comment', parentId: 'test_r_c1', data: bytes, contentType: 'image/png' },
    { tenantId: T, parentType: 'comment', parentId: 'test_r_c1', data: jpg, contentType: 'image/jpeg' },
  ]);
  assert.equal(many.length, 2);
  assert.ok(many.every((a) => a.id), 'IDs kommen aus der DB zurück');
  assert.deepEqual(many.map((a) => a.contentType), ['image/png', 'image/jpeg'], 'Reihenfolge bleibt erhalten');
  assert.deepEqual(many.map((a) => a.sizeBytes), [bytes.length, jpg.length], 'size wird je Zeile aus data abgeleitet');
  assert.equal((await attachments.listForParent('comment', 'test_r_c1')).length, 2);
  assert.deepEqual(await attachments.createMany([]), [], 'leerer Batch macht keinen Query');
  assert.equal((await attachments.listForParents('suggestion', ['test_r_s1', 'nope'], T)).length, 1);
  assert.equal((await attachments.listForParents('suggestion', ['test_r_s1'], 'other-tenant')).length, 0); // tenant-gescopt
  const fetched = await attachments.findWithData(att.id, T);
  assert.ok(fetched.data.equals(bytes));                          // Bytes round-trip
  assert.equal(await attachments.findWithData(att.id, 'other-tenant'), null); // tenant-gescopt
  await attachments.removeForParent('suggestion', 'test_r_s1');
  assert.equal((await attachments.listForParent('suggestion', 'test_r_s1')).length, 0);

  // --- suggestions.remove cascade (votes/comments via FK, activity explizit) ---
  await suggestions.remove('test_r_s1');
  assert.equal(await suggestions.findById('test_r_s1'), null);
  assert.equal((await activity.listByTicket('test_r_s1')).length, 0);
});
