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
  assert.equal((await suggestions.listByApp(A)).length, 1);

  // --- releases + Verknüpfung ---
  const r = await releases.create({ id: 'test_r_rel', tenantId: T, appId: A, version: '1.0', title: 'Launch' });
  assert.equal(r.status, 'geplant');
  const pub = await releases.setPublished('test_r_rel');
  assert.equal(pub.status, 'veröffentlicht');
  assert.ok(pub.publishedAt);
  assert.equal((await releases.listPublishedByApp(A)).length, 1);
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
  await apiKeys.revoke('test_r_key');
  assert.ok((await apiKeys.findByTokenHash('hash_key')).revokedAt);

  // --- attachments ---
  const att = await attachments.create({ tenantId: T, parentType: 'suggestion', parentId: 'test_r_s1', storageKey: 'k/1.png', contentType: 'image/png', sizeBytes: 123 });
  assert.ok(att.id);                                              // von DB generiert
  assert.equal((await attachments.listForParent('suggestion', 'test_r_s1')).length, 1);
  await attachments.removeForParent('suggestion', 'test_r_s1');
  assert.equal((await attachments.listForParent('suggestion', 'test_r_s1')).length, 0);

  // --- suggestions.remove cascade (votes/comments via FK, activity explizit) ---
  await suggestions.remove('test_r_s1');
  assert.equal(await suggestions.findById('test_r_s1'), null);
  assert.equal((await activity.listByTicket('test_r_s1')).length, 0);
});
