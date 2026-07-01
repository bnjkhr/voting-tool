'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hasDatabase } = require('./helpers');

const suite = hasDatabase ? test : test.skip;

const T = 'test_av_tenant';
const A = 'test_av_app';
const S = 'test_av_sug';

async function cleanup() {
  const { query } = require('../../db/pool');
  await query('delete from tenants where id = $1', [T]); // cascade räumt app/suggestion/votes
}

suite('apps + votes repositories', async (t) => {
  const { query } = require('../../db/pool');
  const apps = require('../../db/apps');
  const votes = require('../../db/votes');

  t.after(cleanup);
  await cleanup();

  // Setup: Tenant + Suggestion (Suggestion direkt, Repo kommt später)
  await query(`insert into tenants (id, name, slug) values ($1,'AV','${T}')`, [T]);

  // --- apps ---
  const app = await apps.create({ id: A, tenantId: T, name: 'Board', slug: 'board', ticketPrefix: 'AV' });
  assert.equal(app.id, A);
  assert.equal(app.nextTicketNumber, 1);

  assert.equal((await apps.findBySlug(T, 'board')).id, A);
  assert.equal((await apps.listByTenant(T)).length, 1);

  await apps.update(A, { description: 'Neu' });
  assert.equal((await apps.findById(A)).description, 'Neu');

  // Ticketnummer-Sequenz: 0,1,2 mit Prefix
  const n1 = await apps.nextTicketNumber(A);
  const n2 = await apps.nextTicketNumber(A);
  assert.equal(n1.number, 1);
  assert.equal(n2.number, 2);
  assert.equal(n1.ticketNumber, 'AV-001');
  assert.equal(n2.ticketNumber, 'AV-002');

  // Suggestion für Votes anlegen
  await query(
    `insert into suggestions (id, tenant_id, app_id, type, title) values ($1,$2,$3,'feature','Test')`,
    [S, T, A]
  );

  // --- votes ---
  const first = await votes.cast({ id: 'v1', tenantId: T, suggestionId: S, userFingerprint: 'fp-a' });
  assert.equal(first.created, true);
  assert.equal(first.votes, 1);

  // Doppel-Vote desselben Fingerprints -> kein Increment (Unique-Constraint)
  const dup = await votes.cast({ id: 'v2', tenantId: T, suggestionId: S, userFingerprint: 'fp-a' });
  assert.equal(dup.created, false);
  assert.equal(dup.votes, 1);

  // Anderer Fingerprint -> zählt
  const second = await votes.cast({ id: 'v3', tenantId: T, suggestionId: S, userFingerprint: 'fp-b' });
  assert.equal(second.created, true);
  assert.equal(second.votes, 2);

  assert.equal(await votes.hasVoted(S, 'fp-a'), true);
  assert.equal(await votes.hasVoted(S, 'fp-x'), false);

  const voted = await votes.votedSuggestionIds('fp-a', [S, 'other']);
  assert.deepEqual(voted, [S]);

  // uncast: entfernt + dekrementiert; zweites uncast tut nichts
  const un1 = await votes.uncast({ tenantId: T, suggestionId: S, userFingerprint: 'fp-a' });
  assert.equal(un1.removed, true);
  assert.equal(un1.votes, 1);
  const un2 = await votes.uncast({ tenantId: T, suggestionId: S, userFingerprint: 'fp-a' });
  assert.equal(un2.removed, false);
  assert.equal(await votes.hasVoted(S, 'fp-a'), false);
});
