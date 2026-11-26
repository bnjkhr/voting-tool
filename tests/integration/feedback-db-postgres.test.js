'use strict';

// Angeschlossene Boards und Verknüpfungen gegen echtes Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDatabase } = require('./helpers');

const suite = hasDatabase ? test : test.skip;

// Eigenes Präfix: `node --test` führt die Dateien parallel gegen eine Datenbank aus.
const INTERN = 'test_fbdb_intern'; // private
const ACME = 'test_fbdb_acme'; // active
const TENANTS = [INTERN, ACME];

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from activity where tenant_id = any($1)', [TENANTS]);
  await query('delete from tenants where id = any($1)', [TENANTS]); // cascade
}

suite('Verknüpfungen: Repository', async (t) => {
  const { query, getPool } = require('../../db/pool');
  const feedback = require('../../db/feedback');
  const apps = require('../../db/apps');
  const suggestions = require('../../db/suggestions');

  t.after(async () => {
    await cleanup();
    await getPool().end();
  });
  await cleanup();

  await query(
    `insert into tenants (id, name, slug, status) values
       ($1, 'Intern', 'test-fbdb-intern', 'private'),
       ($2, 'Acme', 'test-fbdb-acme', 'active')`,
    TENANTS
  );

  let boardNumber = 0;
  // Ein frisches Ziel-Board je Testfall, damit sich die Fälle nicht beeinflussen.
  async function board(tenantId = INTERN) {
    boardNumber += 1;
    const id = `test_fbdb_app${boardNumber}`;
    await apps.create({
      id, tenantId, name: `Board ${boardNumber}`, slug: `board-${boardNumber}`, ticketPrefix: 'FB',
    });
    return id;
  }

  const connect = (appId, overrides = {}) => feedback.upsertSource({
    tenantId: INTERN, appId, sourceKind: 'legacy', sourceTenantId: null,
    sourceAppId: `test_fbdb_quelle_${appId}`, ...overrides,
  });

  const ticket = (overrides = {}) => ({
    type: 'ticket', title: 'Titel', description: 'Text', priority: 'hoch', status: 'neu',
    labels: ['Feedback'], approved: true, userFingerprint: 'api:feedback',
    notificationEnabled: false, notificationEmail: null, ...overrides,
  });
  const publicEntry = (id, overrides = {}) => ({
    id, type: 'feature', status: 'wird geprüft', approved: true, ...overrides,
  });
  const create = (source, id, overrides) => feedback.createTicketWithLink({
    source, entry: publicEntry(id), ticket: ticket(overrides),
  });

  const counts = async (appId, sourceId) => (await query(
    `select
       (select count(*)::int from suggestions where app_id = $1) as tickets,
       (select count(*)::int from feedback_links where source_id = $2) as links,
       (select next_ticket_number from apps where id = $1) as next`,
    [appId, sourceId]
  )).rows[0];

  await t.test('Quelle nur in privatem Workspace', async () => {
    const appId = await board(ACME);

    await assert.rejects(
      connect(appId, { tenantId: ACME }),
      feedback.NotPrivateError
    );

    const { rows } = await query('select count(*)::int as n from feedback_sources where app_id = $1', [appId]);
    assert.equal(rows[0].n, 0);
  });

  await t.test('Quelle nur für ein Board des Workspaces', async () => {
    const fremd = await board(ACME);

    await assert.rejects(connect(fremd), feedback.NotPrivateError);
  });

  await t.test('neue Quelle ist ausgeschaltet; erneutes Anschließen ändert nichts', async () => {
    const appId = await board();
    const source = await connect(appId);
    assert.equal(source.fetchEnabled, false);
    assert.equal(source.tenantId, INTERN);
    assert.equal(source.appId, appId);
    await feedback.setFetchEnabled(source.id, true);

    const again = await connect(appId);

    assert.equal(again.id, source.id);
    assert.equal(again.fetchEnabled, true);
  });

  await t.test('andere Quelle für dasselbe Board schaltet das Holen wieder aus', async () => {
    const appId = await board();
    const source = await connect(appId);
    await feedback.setFetchEnabled(source.id, true);
    await feedback.claimFetch(source.id);
    await feedback.recordFetch(source.id, { unapprovedCount: 3, error: 'alt' });

    const changed = await connect(appId, { sourceAppId: 'test_fbdb_quelle_neu' });

    assert.equal(changed.id, source.id);
    assert.equal(changed.sourceAppId, 'test_fbdb_quelle_neu');
    assert.equal(changed.fetchEnabled, false);
    assert.equal(changed.lastFetchedAt, null);
    assert.equal(changed.unapprovedCount, 0);
    assert.equal(changed.lastError, null);
  });

  await t.test('Quelle mit Verknüpfungen lässt sich nicht umhängen', async () => {
    const appId = await board();
    const source = await connect(appId);
    await create(source, 'e1');

    await assert.rejects(
      connect(appId, { sourceAppId: 'test_fbdb_quelle_andere' }),
      feedback.SourceInUseError
    );

    const kept = await feedback.findSourceByApp(INTERN, appId);
    assert.equal(kept.sourceAppId, source.sourceAppId);
  });

  await t.test('eine Quelle je öffentlichem Board', async () => {
    const first = await board();
    const second = await board();
    await connect(first, { sourceAppId: 'test_fbdb_doppelt' });

    await assert.rejects(
      connect(second, { sourceAppId: 'test_fbdb_doppelt' }),
      { code: '23505' }
    );

    assert.equal(await feedback.findSourceByApp(INTERN, second), null);
  });

  await t.test('listSources und findSourceByApp bleiben im Workspace', async () => {
    const appId = await board();
    const source = await connect(appId);

    assert.ok((await feedback.listSources(INTERN)).some((row) => row.id === source.id));
    assert.deepEqual(await feedback.listSources(ACME), []);
    assert.equal(await feedback.findSourceByApp(ACME, appId), null);
    const listed = (await feedback.listSources(INTERN)).find((row) => row.id === source.id);
    assert.match(listed.boardName, /^Board \d+$/);
    assert.match(listed.boardSlug, /^board-\d+$/);
  });

  await t.test('Ticket und Verknüpfung entstehen zusammen', async () => {
    const appId = await board();
    const source = await connect(appId);

    const result = await create(source, 'e1');

    assert.equal(result.created, true);
    assert.equal(result.suggestion.tenantId, INTERN);
    assert.equal(result.suggestion.appId, appId);
    assert.equal(result.suggestion.ticketNumber, 'FB-001');
    assert.equal(result.suggestion.notificationEnabled, false);
    const [link] = await feedback.listLinksBySource(source.id);
    assert.equal(link.suggestionId, result.suggestion.id);
    assert.equal(link.entryId, 'e1');
    assert.equal(link.publicType, 'feature');
    assert.equal(link.publicStatus, 'wird geprüft');
    assert.equal(link.publicApproved, true);
    assert.equal(link.publicDeleted, false);
    assert.ok(link.publicSeenAt);
  });

  await t.test('Ziel-Board kommt aus der Zeile, nicht aus dem Aufruf', async () => {
    const appId = await board();
    const fremd = await board(ACME);
    const source = await connect(appId);

    const result = await feedback.createTicketWithLink({
      source: { ...source, appId: fremd, tenantId: ACME },
      entry: publicEntry('e1'),
      ticket: ticket({ appId: fremd, tenantId: ACME }),
    });

    assert.equal(result.suggestion.appId, appId);
    assert.equal(result.suggestion.tenantId, INTERN);
  });

  await t.test('kein Ticket, wenn der Workspace nicht mehr privat ist', async () => {
    const appId = await board();
    const source = await connect(appId);
    await query("update tenants set status = 'active' where id = $1", [INTERN]);
    try {
      assert.equal((await create(source, 'e1')).created, false);
      assert.deepEqual(await counts(appId, source.id), { tickets: 0, links: 0, next: 1 });
    } finally {
      await query("update tenants set status = 'private' where id = $1", [INTERN]);
    }
  });

  await t.test('gleichzeitige Inserts ergeben ein Ticket', async () => {
    const appId = await board();
    const source = await connect(appId);

    const results = await Promise.all(Array.from({ length: 5 }, () => create(source, 'e1')));

    assert.deepEqual(await counts(appId, source.id), { tickets: 1, links: 1, next: 2 });
    assert.equal(results.filter((result) => result.created).length, 1);
  });

  await t.test('Ticketnummer läuft in der Transaktion', async () => {
    const appId = await board();
    const source = await connect(appId);

    await assert.rejects(create(source, 'e1', { priority: 'dringend' }), { code: '23514' });

    assert.deepEqual(await counts(appId, source.id), { tickets: 0, links: 0, next: 1 });
  });

  await t.test('5-Minuten-Marke', async () => {
    const appId = await board();
    const source = await connect(appId);
    assert.equal(await feedback.claimFetch(source.id), false);
    await feedback.setFetchEnabled(source.id, true);

    assert.equal(await feedback.claimFetch(source.id), true);
    assert.equal(await feedback.claimFetch(source.id), false);
    await query(
      "update feedback_sources set last_fetched_at = now() - interval '6 minutes' where id = $1",
      [source.id]
    );
    assert.equal(await feedback.claimFetch(source.id), true);
    await query(
      "update feedback_sources set last_fetched_at = now() - interval '6 minutes' where id = $1",
      [source.id]
    );
    await feedback.setFetchEnabled(source.id, false);
    assert.equal(await feedback.claimFetch(source.id), false);
  });

  await t.test('gleichzeitige Marken: genau eine gewinnt', async () => {
    const appId = await board();
    const source = await connect(appId);
    await feedback.setFetchEnabled(source.id, true);

    const results = await Promise.all(Array.from({ length: 5 }, () => feedback.claimFetch(source.id)));

    assert.equal(results.filter(Boolean).length, 1);
  });

  await t.test('recordFetch merkt Anzahl und Fehler; ohne Anzahl bleibt die alte', async () => {
    const appId = await board();
    const source = await connect(appId);

    await feedback.recordFetch(source.id, { unapprovedCount: 2, error: null });
    await feedback.recordFetch(source.id, { error: 'nicht erreichbar' });

    const stored = await feedback.findSourceByApp(INTERN, appId);
    assert.equal(stored.unapprovedCount, 2);
    assert.equal(stored.lastError, 'nicht erreichbar');
    await feedback.recordFetch(source.id, { unapprovedCount: 0, error: null });
    const cleared = await feedback.findSourceByApp(INTERN, appId);
    assert.equal(cleared.unapprovedCount, 0);
    assert.equal(cleared.lastError, null);
  });

  await t.test('refreshLinks zeigt den neuen Stand; gelöscht behält den letzten', async () => {
    const appId = await board();
    const source = await connect(appId);
    await create(source, 'e1');
    const [link] = await feedback.listLinksBySource(source.id);

    await feedback.refreshLinks([{
      linkId: link.id, publicStatus: 'im Test', publicType: 'bug', publicApproved: false, publicDeleted: false,
    }]);
    const [seen] = await feedback.listLinksBySource(source.id);
    assert.deepEqual(
      [seen.publicStatus, seen.publicType, seen.publicApproved, seen.publicDeleted],
      ['im Test', 'bug', false, false]
    );

    await feedback.refreshLinks([{ linkId: link.id, publicDeleted: true }]);
    const [gone] = await feedback.listLinksBySource(source.id);
    assert.deepEqual(
      [gone.publicStatus, gone.publicType, gone.publicApproved, gone.publicDeleted],
      ['im Test', 'bug', false, true]
    );
    assert.deepEqual(gone.publicSeenAt, seen.publicSeenAt);
  });

  await t.test('listLinks nennt Board und Quelle und bleibt im Workspace', async () => {
    const appId = await board();
    const source = await connect(appId);
    await create(source, 'e1');

    const link = (await feedback.listLinks(INTERN)).find((row) => row.sourceId === source.id);

    assert.equal(link.appId, appId);
    assert.equal(link.sourceKind, 'legacy');
    assert.equal(link.sourceAppId, source.sourceAppId);
    assert.equal(link.sourceTenantId, null);
    assert.deepEqual(await feedback.listLinks(ACME), []);
  });

  await t.test('Grabstein nach Löschen und Lösen', async () => {
    const appId = await board();
    const source = await connect(appId);
    const deleted = (await create(source, 'e1')).suggestion;
    const unlinked = (await create(source, 'e2')).suggestion;

    await suggestions.remove(deleted.id);
    assert.equal(await feedback.unlinkSuggestion({ tenantId: INTERN, suggestionId: unlinked.id }), true);

    const links = await feedback.listLinksBySource(source.id);
    assert.deepEqual(links.map((link) => link.suggestionId), [null, null]);
    assert.equal((await create(source, 'e1')).created, false);
    assert.equal((await create(source, 'e2')).created, false);
    assert.equal((await counts(appId, source.id)).tickets, 1);
  });

  await t.test('Lösen nur im eigenen Workspace und nur, was verknüpft ist', async () => {
    const appId = await board();
    const source = await connect(appId);
    const { suggestion } = await create(source, 'e1');

    assert.equal(await feedback.unlinkSuggestion({ tenantId: ACME, suggestionId: suggestion.id }), false);
    assert.equal(await feedback.unlinkSuggestion({ tenantId: INTERN, suggestionId: 'gibtsnicht' }), false);
    assert.equal((await feedback.listLinksBySource(source.id))[0].suggestionId, suggestion.id);
  });

  await t.test('von Hand verknüpfen', async () => {
    const appId = await board();
    const source = await connect(appId);
    const tombstone = (await create(source, 'e1')).suggestion;
    await suggestions.remove(tombstone.id);
    const own = (id) => suggestions.create({
      id: `test_fbdb_${appId}_${id}`, tenantId: INTERN, appId, type: 'ticket', title: id,
    });
    const first = await own('a');
    const second = await own('b');
    const link = (suggestionId, entryId, tenantId = INTERN) => feedback.linkSuggestion({
      tenantId, suggestionId, entryId,
    });

    // Der Grabstein bekommt das neue Ticket, der alte öffentliche Stand ist weg.
    const linked = await link(first.id, 'e1');
    assert.equal(linked.suggestionId, first.id);
    assert.equal(linked.entryId, 'e1');
    assert.equal(linked.publicStatus, null);
    assert.equal(linked.publicSeenAt, null);
    assert.equal(linked.publicDeleted, false);
    assert.equal((await feedback.listLinksBySource(source.id)).length, 1);

    // Dasselbe noch einmal ist kein Konflikt.
    assert.equal((await link(first.id, 'e1')).id, linked.id);
    // Eintrag schon an einem anderen Ticket.
    await assert.rejects(link(second.id, 'e1'), feedback.LinkConflictError);
    // Ticket schon verknüpft.
    await assert.rejects(link(first.id, 'e2'), feedback.LinkConflictError);
    // Fremder Workspace sieht das Ticket nicht.
    await assert.rejects(link(second.id, 'e3', ACME), feedback.NoSourceError);

    const lonely = await board();
    const ohne = await suggestions.create({
      id: 'test_fbdb_ohne', tenantId: INTERN, appId: lonely, type: 'ticket', title: 'Ohne Quelle',
    });
    await assert.rejects(link(ohne.id, 'e1'), feedback.NoSourceError);
  });

  await t.test('gleichzeitiges Verknüpfen desselben Eintrags: eine gewinnt', async () => {
    const appId = await board();
    const source = await connect(appId);
    const own = await Promise.all(['a', 'b'].map((id) => suggestions.create({
      id: `test_fbdb_${appId}_${id}`, tenantId: INTERN, appId, type: 'ticket', title: id,
    })));

    const results = await Promise.allSettled(own.map((item) => feedback.linkSuggestion({
      tenantId: INTERN, suggestionId: item.id, entryId: 'e1',
    })));

    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.ok(results.find((result) => result.status === 'rejected').reason instanceof feedback.LinkConflictError);
    assert.equal((await feedback.listLinksBySource(source.id)).length, 1);
  });

  await t.test('Board löschen räumt Quelle und Verknüpfungen ab', async () => {
    const appId = await board();
    const source = await connect(appId);
    await create(source, 'e1');

    await apps.remove(appId, INTERN);

    const { rows } = await query(
      `select (select count(*)::int from feedback_sources where id = $1) as sources,
              (select count(*)::int from feedback_links where source_id = $1) as links`,
      [source.id]
    );
    assert.deepEqual(rows[0], { sources: 0, links: 0 });
  });
});
