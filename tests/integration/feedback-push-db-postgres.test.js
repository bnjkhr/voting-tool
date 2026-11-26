'use strict';

// Schalter, wartende Änderung und Anspruch fürs Zurückschreiben gegen echtes
// Postgres.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hasDatabase } = require('./helpers');

const suite = hasDatabase ? test : test.skip;

// Eigenes Präfix: `node --test` führt die Dateien parallel gegen eine Datenbank aus.
const INTERN = 'test_fbpush_intern'; // private
const OTHER = 'test_fbpush_other'; // private
const TENANTS = [INTERN, OTHER];

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from activity where tenant_id = any($1)', [TENANTS]);
  await query('delete from tenants where id = any($1)', [TENANTS]); // cascade
}

suite('Zurückschreiben: Repository', async (t) => {
  const { query, getPool } = require('../../db/pool');
  const feedback = require('../../db/feedback');
  const apps = require('../../db/apps');

  t.after(async () => {
    await cleanup();
    await getPool().end();
  });
  await cleanup();

  await query(
    `insert into tenants (id, name, slug, status) values
       ($1, 'Intern', 'test-fbpush-intern', 'private'),
       ($2, 'Anders', 'test-fbpush-other', 'private')`,
    TENANTS
  );

  let number = 0;

  // Je Testfall ein frisches Board mit Quelle und einem verknüpften Ticket.
  async function linked({ push = true, status = 'offen' } = {}) {
    number += 1;
    const appId = `test_fbpush_app${number}`;
    await apps.create({
      id: appId, tenantId: INTERN, name: `Board ${number}`, slug: `board-${number}`, ticketPrefix: 'FP',
    });
    let source = await feedback.upsertSource({
      tenantId: INTERN, appId, sourceKind: 'legacy', sourceAppId: `test_fbpush_quelle${number}`,
    });
    if (push) source = await feedback.setPushEnabled(source.id, true);
    const suggestionId = `test_fbpush_ticket${number}`;
    await query(
      `insert into suggestions (id, tenant_id, app_id, type, title, status, approved, approved_at)
       values ($1, $2, $3, 'ticket', 'Titel', $4, true, now())`,
      [suggestionId, INTERN, appId, status]
    );
    await feedback.linkSuggestion({ tenantId: INTERN, suggestionId, entryId: `eintrag${number}` });
    return { source, suggestionId, ids: { tenantId: INTERN, suggestionId } };
  }

  const row = async (suggestionId) => (await query(
    'select * from feedback_links where suggestion_id = $1', [suggestionId]
  )).rows[0];

  const pend = (target, fields = {}) => feedback.setPending({
    ...target.ids, status: 'gelöst', reason: 'busy', mail: false, error: null, ...fields,
  });
  const claim = (target, expectStatus = 'gelöst') => feedback.claimPush({ ...target.ids, expectStatus });
  const ticketStatus = (suggestionId, status) => query(
    'update suggestions set status = $2 where id = $1', [suggestionId, status]
  );
  const age = (suggestionId, interval) => query(
    `update feedback_links set push_claimed_at = now() - $2::interval where suggestion_id = $1`,
    [suggestionId, interval]
  );

  await t.test('Schalter ist ab Werk aus', async () => {
    const target = await linked({ push: false });

    assert.equal(target.source.pushEnabled, false);
    const [link] = (await feedback.listLinks(INTERN)).filter((l) => l.suggestionId === target.suggestionId);
    assert.deepEqual(
      [link.pushEnabled, link.pendingStatus, link.pendingReason, link.pendingMail, link.pendingError, link.pushStage],
      [false, null, null, false, null, null]
    );
  });

  await t.test('Schalter aus: keine wartende Änderung', async () => {
    const target = await linked({ push: false });
    const before = await row(target.suggestionId);

    assert.equal(await pend(target), null);

    assert.deepEqual(await row(target.suggestionId), before);
  });

  await t.test('wartende Änderung setzen und löschen', async () => {
    const target = await linked();

    const set = await pend(target, { reason: 'mail', mail: true });
    assert.deepEqual(
      [set.pendingStatus, set.pendingReason, set.pendingMail, set.pendingError],
      ['gelöst', 'mail', true, null]
    );
    assert.ok((await row(target.suggestionId)).pending_at);

    const cleared = await pend(target, { status: null });
    assert.deepEqual(
      [cleared.pendingStatus, cleared.pendingReason, cleared.pendingMail, cleared.pendingError],
      [null, null, false, null]
    );
    assert.equal((await row(target.suggestionId)).pending_at, null);
  });

  await t.test('ein überholter Statuswechsel setzt nichts', async () => {
    const target = await linked({ status: 'gelöst' });
    await pend(target, { ifTicketStatus: 'gelöst' });

    assert.equal(await pend(target, { status: 'in Bearbeitung', ifTicketStatus: 'in Bearbeitung' }), null);
    assert.equal(await pend(target, { status: null, ifTicketStatus: 'offen' }), null);

    assert.equal((await row(target.suggestionId)).pending_status, 'gelöst');
  });

  await t.test('Ausschalten löscht wartende Änderungen', async () => {
    const target = await linked();
    const other = await linked();
    await pend(target, { reason: 'failed', mail: true, error: 'Fehler' });
    await pend(other);

    const source = await feedback.setPushEnabled(target.source.id, false);

    assert.equal(source.pushEnabled, false);
    const cleared = await row(target.suggestionId);
    assert.deepEqual(
      [cleared.pending_status, cleared.pending_reason, cleared.pending_mail, cleared.pending_error, cleared.pending_at],
      [null, null, false, null, null]
    );
    assert.equal((await row(other.suggestionId)).pending_status, 'gelöst');
    // Wieder einschalten holt nichts zurück.
    await feedback.setPushEnabled(target.source.id, true);
    assert.equal((await row(target.suggestionId)).pending_status, null);
  });

  await t.test('Ausschalten lässt einen laufenden Mailversand stehen, danach bleibt nichts offen', async () => {
    const target = await linked();
    await pend(target);
    const { token } = await claim(target);
    assert.equal(await feedback.markMailing(token), true);
    await pend(target, { status: 'in Bearbeitung' });

    await feedback.setPushEnabled(target.source.id, false);

    assert.equal((await row(target.suggestionId)).push_stage, 'mailing');
    assert.equal((await row(target.suggestionId)).pending_status, 'in Bearbeitung');
    await feedback.finishPush(token, { publicStatus: 'gelöst' });
    const done = await row(target.suggestionId);
    assert.deepEqual([done.push_claim, done.pending_status, done.pushed_status], [null, null, 'gelöst']);
  });

  await t.test('ein Claim gewinnt', async () => {
    const target = await linked();
    await pend(target);

    const results = await Promise.all(Array.from({ length: 5 }, () => claim(target)));

    const won = results.filter(Boolean);
    assert.equal(won.length, 1, `${won.length} Token`);
    assert.equal(won[0].link.suggestionId, target.suggestionId);
    assert.equal(won[0].link.sourceKind, 'legacy');
    assert.equal(won[0].link.pushStage, 'writing');
    assert.equal(won[0].link.pushEnabled, true);
    assert.equal((await row(target.suggestionId)).push_claim, won[0].token);
  });

  await t.test('Claim nur für den erwarteten Status', async () => {
    const target = await linked();
    await pend(target);

    assert.equal(await claim(target, 'in Bearbeitung'), null);

    assert.equal((await row(target.suggestionId)).push_claim, null);
  });

  await t.test('kein Claim bei ausgeschaltetem Schalter oder nicht privatem Workspace', async () => {
    const target = await linked();
    await pend(target);
    await query("update tenants set status = 'active' where id = $1", [INTERN]);
    try {
      assert.equal(await claim(target), null);
    } finally {
      await query("update tenants set status = 'private' where id = $1", [INTERN]);
    }
    await query('update feedback_sources set push_enabled = false where id = $1', [target.source.id]);
    assert.equal(await claim(target), null);
  });

  await t.test('hängender Mailversand wird nie neu beansprucht', async () => {
    const target = await linked();
    await pend(target);
    const first = await claim(target);
    await feedback.markMailing(first.token);
    await age(target.suggestionId, '1 hour');

    assert.equal(await claim(target), null);

    // Ein hängendes Schreiben darf nach zwei Minuten neu genommen werden.
    await query("update feedback_links set push_stage = 'writing' where suggestion_id = $1", [target.suggestionId]);
    await age(target.suggestionId, '1 minute');
    assert.equal(await claim(target), null);
    await age(target.suggestionId, '3 minutes');
    const second = await claim(target);
    assert.ok(second?.token);
    assert.notEqual(second.token, first.token);
  });

  await t.test('neuere Änderung bleibt stehen', async () => {
    const target = await linked();
    await pend(target, { reason: 'backward' });
    const { token } = await claim(target);

    const newer = await pend(target, { status: 'in Bearbeitung', reason: 'mail', mail: true });

    assert.deepEqual([newer.pendingStatus, newer.pendingReason], ['in Bearbeitung', 'busy']);
    const during = await row(target.suggestionId);
    assert.deepEqual([during.push_claim, during.push_stage], [token, 'writing']);
    assert.equal(await feedback.holdsPush(token, 'gelöst'), false);
    // Weder Freigeben noch Abschließen mit dem alten Status rührt die neuere an.
    await feedback.finishPush(token, { publicStatus: 'gelöst', error: 'Fehler' });
    const after = await row(target.suggestionId);
    assert.deepEqual(
      [after.pending_status, after.pending_reason, after.pending_mail, after.pending_error],
      ['in Bearbeitung', 'busy', true, null]
    );
    assert.deepEqual([after.push_claim, after.push_stage, after.public_status], [null, null, 'gelöst']);
  });

  await t.test('Abschließen löscht die geschriebene Änderung', async () => {
    const target = await linked();
    await pend(target, { reason: 'mail', mail: true });
    const { token } = await claim(target);
    assert.equal(await feedback.holdsPush(token, 'gelöst'), true);

    await feedback.finishPush(token, { publicStatus: 'gelöst' });

    const done = await row(target.suggestionId);
    assert.deepEqual(
      [done.pending_status, done.pending_reason, done.pending_mail, done.pending_error, done.push_claim],
      [null, null, false, null, null]
    );
    assert.deepEqual([done.public_status, done.pushed_status], ['gelöst', 'gelöst']);
    assert.ok(done.pushed_at && done.public_seen_at);
  });

  await t.test('Abschließen merkt sich eine gescheiterte Mail', async () => {
    const target = await linked();
    await pend(target);
    const { token } = await claim(target);

    await feedback.finishPush(token, { publicStatus: 'gelöst', error: 'Die Mail ging nicht raus.' });

    const done = await row(target.suggestionId);
    assert.deepEqual([done.pending_status, done.pending_error], [null, 'Die Mail ging nicht raus.']);
  });

  await t.test('Freigeben behält die Änderung mit Grund', async () => {
    const target = await linked();
    await pend(target);
    const { token } = await claim(target);

    await feedback.releasePush(token, { status: 'gelöst', reason: 'failed', error: 'Fehler' });

    const released = await row(target.suggestionId);
    assert.deepEqual(
      [released.pending_status, released.pending_reason, released.pending_mail, released.pending_error,
        released.push_claim, released.push_stage],
      ['gelöst', 'failed', false, 'Fehler', null, null]
    );
    // Ohne `mail` bleibt der Wert stehen.
    await query('update feedback_links set pending_mail = true where suggestion_id = $1', [target.suggestionId]);
    const again = await claim(target);
    await feedback.releasePush(again.token, { status: 'gelöst', reason: 'backward' });
    const kept = await row(target.suggestionId);
    assert.deepEqual([kept.pending_reason, kept.pending_mail, kept.pending_error], ['backward', true, null]);
  });

  await t.test('Freigeben nach Verwerfen im Lauf legt nichts neu an', async () => {
    const target = await linked();
    await pend(target);
    const { token } = await claim(target);
    await pend(target, { status: null });

    await feedback.releasePush(token, { status: 'gelöst', reason: 'failed', error: 'Fehler' });

    const released = await row(target.suggestionId);
    assert.deepEqual(
      [released.pending_status, released.pending_reason, released.pending_error, released.push_claim],
      [null, null, null, null]
    );
  });

  await t.test('Fallenlassen und Umstellen', async () => {
    const target = await linked();
    await pend(target);
    const { token } = await claim(target);

    assert.equal(await feedback.retargetPush(token, 'gelöst', 'ist umgesetzt'), true);
    assert.equal(await feedback.retargetPush(token, 'gelöst', 'in Bearbeitung'), false);
    assert.equal(await feedback.holdsPush(token, 'ist umgesetzt'), true);
    await feedback.dropPush(token, { status: 'ist umgesetzt', publicStatus: 'ist umgesetzt' });

    const dropped = await row(target.suggestionId);
    assert.deepEqual(
      [dropped.pending_status, dropped.pending_reason, dropped.push_claim, dropped.public_status, dropped.pushed_status],
      [null, null, null, 'ist umgesetzt', null]
    );
  });

  await t.test('abgelaufener Claim mailt nicht', async () => {
    const target = await linked();
    await pend(target);
    const first = await claim(target);
    await feedback.releasePush(first.token, { status: 'gelöst', reason: 'failed' });
    assert.equal(await feedback.markMailing(first.token), false);

    const second = await claim(target);
    await age(target.suggestionId, '3 minutes');
    const third = await claim(target);

    assert.equal(await feedback.markMailing(second.token), false);
    assert.equal(await feedback.holdsPush(second.token, 'gelöst'), false);
    // Auch Abschließen und Freigeben mit altem Token tun nichts.
    await feedback.finishPush(second.token, { publicStatus: 'gelöst' });
    await feedback.releasePush(second.token, { status: 'gelöst', reason: 'failed' });
    assert.equal((await row(target.suggestionId)).push_claim, third.token);
    assert.equal(await feedback.markMailing(third.token), true);
    assert.equal(await feedback.markMailing(third.token), false);
  });

  await t.test('Freigeben rührt einen laufenden Mailversand nicht an', async () => {
    const target = await linked();
    await pend(target);
    const { token } = await claim(target);
    await feedback.markMailing(token);

    await feedback.releasePush(token, { status: 'gelöst', reason: 'failed' });
    await feedback.dropPush(token, { status: 'gelöst', publicStatus: 'gelöst' });

    const kept = await row(target.suggestionId);
    assert.deepEqual([kept.push_claim, kept.push_stage, kept.pending_status], [token, 'mailing', 'gelöst']);
  });

  await t.test('Verwerfen, auch bei hängendem Mailversand', async () => {
    const target = await linked();
    await pend(target);
    const { token } = await claim(target);
    await feedback.markMailing(token);
    await age(target.suggestionId, '1 hour');

    assert.equal(await feedback.discardPending(target.ids), true);

    const discarded = await row(target.suggestionId);
    assert.deepEqual(
      [discarded.pending_status, discarded.pending_reason, discarded.pending_mail, discarded.push_claim, discarded.push_stage],
      [null, null, false, null, null]
    );
    assert.equal(await feedback.discardPending(target.ids), false);
  });

  await t.test('anderer Workspace', async () => {
    const target = await linked();
    await pend(target);
    const before = await row(target.suggestionId);
    const foreign = { tenantId: OTHER, suggestionId: target.suggestionId };

    assert.equal(await feedback.claimPush({ ...foreign, expectStatus: 'gelöst' }), null);
    assert.equal(await feedback.setPending({ ...foreign, status: null }), null);
    assert.equal(await feedback.setPending({ ...foreign, status: 'offen', reason: 'busy' }), null);
    assert.equal(await feedback.discardPending(foreign), false);
    assert.equal(await feedback.findLink(OTHER, target.suggestionId), null);

    assert.deepEqual(await row(target.suggestionId), before);
    assert.equal((await feedback.findLink(INTERN, target.suggestionId)).entryId, before.entry_id);
  });

  await t.test('Lösen und neu Verknüpfen nimmt nichts Wartendes mit', async () => {
    const target = await linked();
    await pend(target, { reason: 'mail', mail: true });
    const { token } = await claim(target);
    const { entry_id: entryId } = await row(target.suggestionId);

    await feedback.unlinkSuggestion(target.ids);

    const tombstone = async () => (await query(
      'select * from feedback_links where source_id = $1', [target.source.id]
    )).rows[0];
    const unlinked = await tombstone();
    assert.deepEqual(
      [unlinked.pending_status, unlinked.pending_mail, unlinked.push_claim, unlinked.push_stage],
      [null, false, null, null]
    );
    assert.equal(await feedback.markMailing(token), false);

    // Ein gelöschtes Ticket hinterlässt Reste im Grabstein; neu verknüpft sind sie weg.
    await feedback.linkSuggestion({ ...target.ids, entryId });
    await pend(target, { reason: 'mail', mail: true });
    await claim(target);
    await query('delete from suggestions where id = $1', [target.suggestionId]);
    const appId = (await query('select app_id from feedback_sources where id = $1', [target.source.id])).rows[0].app_id;
    await query(
      `insert into suggestions (id, tenant_id, app_id, type, title, status)
       values ($1, $2, $3, 'ticket', 'Neu', 'offen')`,
      [`${target.suggestionId}_neu`, INTERN, appId]
    );
    await feedback.linkSuggestion({ tenantId: INTERN, suggestionId: `${target.suggestionId}_neu`, entryId });
    const relinked = await tombstone();
    assert.deepEqual(
      [relinked.pending_status, relinked.pending_reason, relinked.pending_mail, relinked.push_claim, relinked.pushed_status],
      [null, null, false, null, null]
    );
  });

  await t.test('Quelle umgehängt', async () => {
    const appId = 'test_fbpush_app_umhaengen';
    await apps.create({ id: appId, tenantId: INTERN, name: 'Um', slug: 'um', ticketPrefix: 'UM' });
    const input = { tenantId: INTERN, appId, sourceKind: 'legacy', sourceAppId: 'test_fbpush_um_alt' };
    const source = await feedback.upsertSource(input);
    await feedback.setPushEnabled(source.id, true);

    assert.equal((await feedback.upsertSource(input)).pushEnabled, true);
    const moved = await feedback.upsertSource({ ...input, sourceAppId: 'test_fbpush_um_neu' });

    // Verknüpfungen (und damit wartende Änderungen) kann eine umgehängte Quelle
    // nicht haben: Mit Verknüpfungen lehnt upsertSource das Umhängen ab.
    assert.equal(moved.pushEnabled, false);
    const target = await linked();
    await pend(target);
    await assert.rejects(
      feedback.upsertSource({
        tenantId: INTERN, appId: target.source.appId, sourceKind: 'legacy', sourceAppId: 'test_fbpush_um_x',
      }),
      feedback.SourceInUseError
    );
    assert.equal((await row(target.suggestionId)).pending_status, 'gelöst');
  });

  await t.test('Skript: Probelauf schreibt nichts, disable-push --commit räumt auf, Exit 1 ohne privat', async () => {
    const target = await linked();
    await pend(target, { reason: 'mail', mail: true });
    const { slug } = (await query(
      'select a.slug from apps a join feedback_sources s on s.app_id = a.id where s.id = $1', [target.source.id]
    )).rows[0];
    // Leerer Ordner, damit keine .env gelesen wird.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-push-'));
    const script = (...args) => spawnSync(
      process.execPath,
      [path.join(__dirname, '..', '..', 'scripts', 'feedback-sources.js'), ...args, '--board', slug],
      {
        cwd, encoding: 'utf8',
        env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, PGSSLMODE: process.env.PGSSLMODE },
      }
    );
    try {
      const dry = script('disable-push', '--workspace', 'test-fbpush-intern');
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, /gelöscht würden: 1/);
      assert.equal((await row(target.suggestionId)).pending_status, 'gelöst');

      const done = script('disable-push', '--workspace', 'test-fbpush-intern', '--commit');
      assert.equal(done.status, 0, done.stderr);
      assert.equal((await row(target.suggestionId)).pending_status, null);
      assert.equal((await feedback.listSources(INTERN)).find((s) => s.id === target.source.id).pushEnabled, false);

      await query("update tenants set status = 'active' where id = $1", [INTERN]);
      const refused = script('enable-push', '--workspace', 'test-fbpush-intern', '--commit');
      assert.equal(refused.status, 1, refused.stdout);
      assert.match(refused.stderr, /nur private Workspaces/);
      assert.equal((await feedback.listSources(INTERN)).find((s) => s.id === target.source.id).pushEnabled, false);
    } finally {
      await query("update tenants set status = 'private' where id = $1", [INTERN]);
      fs.rmdirSync(cwd);
    }
  });
  await t.test('bedingtes Update: nur auf dem gelesenen Stand', async () => {
    const suggestions = require('../../db/suggestions');
    const target = await linked({ status: 'offen' });
    const read = await suggestions.findByIdWithVersion(target.suggestionId);
    assert.ok(read.rowVersion);
    assert.equal(read.status, 'offen');

    const written = await suggestions.updateIfUnchanged(target.suggestionId, read.rowVersion, { status: 'gelöst' });

    assert.equal(written.status, 'gelöst');
    // Derselbe alte Stand gilt nicht mehr, auch wenn der Status wieder passt.
    await ticketStatus(target.suggestionId, 'offen');
    assert.equal(
      await suggestions.updateIfUnchanged(target.suggestionId, read.rowVersion, { status: 'in Bearbeitung' }),
      null
    );
    assert.equal((await suggestions.findById(target.suggestionId)).status, 'offen');
    for (const version of [undefined, null, '', '0']) {
      assert.equal(await suggestions.updateIfUnchanged(target.suggestionId, version, { status: 'x' }), null);
    }
    assert.equal((await suggestions.findById(target.suggestionId)).status, 'offen');
    assert.equal(await suggestions.findByIdWithVersion('test_fbpush_gibtsnicht'), null);
  });

  await t.test('Claim und Verwerfen binden den Eintrag', async () => {
    const target = await linked();
    await pend(target);
    const { entry_id: entryId } = await row(target.suggestionId);

    assert.equal(await feedback.claimPush({ ...target.ids, expectStatus: 'gelöst', expectEntryId: 'x' }), null);
    assert.equal(await feedback.discardPending({ ...target.ids, entryId: 'x' }), false);
    assert.equal((await row(target.suggestionId)).pending_status, 'gelöst');

    assert.ok(await feedback.claimPush({ ...target.ids, expectStatus: 'gelöst', expectEntryId: entryId }));
    assert.equal(await feedback.discardPending({ ...target.ids, entryId }), true);
  });
});
