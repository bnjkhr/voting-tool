const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INVITE_STATUSES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  buildLoginLinkData,
  buildInviteTokenHash,
  buildMembershipData,
  buildSessionData,
  buildTenantInviteData,
  buildUserData,
  isInviteExpired,
  isLoginLinkExpired,
  isSessionExpired,
  normalizeInviteEmail,
  normalizeMembershipRole,
} = require('../api/team-utils');

test('team role constants stay explicit', () => {
  assert.deepEqual(MEMBERSHIP_ROLES, ['owner', 'admin', 'viewer']);
  assert.deepEqual(MEMBERSHIP_STATUSES, ['active', 'disabled']);
  assert.deepEqual(INVITE_STATUSES, ['pending', 'accepted', 'revoked', 'expired']);
});

test('normalizes invite email and role', () => {
  assert.equal(normalizeInviteEmail('  USER@Example.COM '), 'user@example.com');
  assert.equal(normalizeMembershipRole('owner'), 'owner');
  assert.equal(normalizeMembershipRole('admin'), 'admin');
  assert.equal(normalizeMembershipRole('viewer'), 'viewer');
  assert.equal(normalizeMembershipRole('invalid'), 'viewer');
});

test('rejects invalid invite email', () => {
  assert.throws(() => normalizeInviteEmail('not-an-email'), /Invalid invite email/);
});

test('builds tenant invite data without storing the raw token', () => {
  const invite = buildTenantInviteData({
    tenantId: 'acme',
    email: 'Admin@Example.com',
    role: 'admin',
    token: 'secret-token',
    now: new Date('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(invite.tenantId, 'acme');
  assert.equal(invite.email, 'admin@example.com');
  assert.equal(invite.role, 'admin');
  assert.equal(invite.status, 'pending');
  assert.equal(invite.token, undefined);
  assert.equal(invite.tokenHash, buildInviteTokenHash('secret-token'));
  assert.equal(invite.expiresAt.toISOString(), '2026-01-08T00:00:00.000Z');
});

test('detects expired invites from date-like values', () => {
  assert.equal(
    isInviteExpired({ expiresAt: new Date('2026-01-02T00:00:00.000Z') }, new Date('2026-01-01T00:00:00.000Z')),
    false
  );
  assert.equal(
    isInviteExpired({ expiresAt: new Date('2025-12-31T00:00:00.000Z') }, new Date('2026-01-01T00:00:00.000Z')),
    true
  );
});

test('builds user and membership data for accepted invites', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const user = buildUserData({ email: 'Admin@Example.com', displayName: ' Admin User ', now });
  const membership = buildMembershipData({ tenantId: 'acme', userId: 'user-1', role: 'owner', now });

  assert.equal(user.email, 'admin@example.com');
  assert.equal(user.displayName, 'Admin User');
  assert.equal(user.status, 'active');
  assert.equal(membership.tenantId, 'acme');
  assert.equal(membership.userId, 'user-1');
  assert.equal(membership.role, 'owner');
  assert.equal(membership.status, 'active');
});

test('builds hashed user session data without storing the raw token', () => {
  const session = buildSessionData({
    userId: 'user-1',
    token: 'raw-session-token',
    now: new Date('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(session.userId, 'user-1');
  assert.equal(session.status, 'active');
  assert.equal(session.token, undefined);
  assert.equal(session.tokenHash, buildInviteTokenHash('raw-session-token'));
  assert.equal(session.expiresAt.toISOString(), '2026-01-31T00:00:00.000Z');
  assert.equal(isSessionExpired(session, new Date('2026-01-02T00:00:00.000Z')), false);
  assert.equal(isSessionExpired(session, new Date('2026-02-01T00:00:00.000Z')), true);
});

test('builds hashed login link data for email login', () => {
  const loginLink = buildLoginLinkData({
    email: ' User@Example.COM ',
    token: 'raw-login-token',
    now: new Date('2026-01-01T00:00:00.000Z'),
  });

  assert.equal(loginLink.email, 'user@example.com');
  assert.equal(loginLink.status, 'pending');
  assert.equal(loginLink.token, undefined);
  assert.equal(loginLink.tokenHash, buildInviteTokenHash('raw-login-token'));
  assert.equal(loginLink.expiresAt.toISOString(), '2026-01-01T00:15:00.000Z');
  assert.equal(isLoginLinkExpired(loginLink, new Date('2026-01-01T00:10:00.000Z')), false);
  assert.equal(isLoginLinkExpired(loginLink, new Date('2026-01-01T00:16:00.000Z')), true);
});

test('login link redirectUrl rejects open-redirect bypass attempts', () => {
  const baseArgs = {
    email: 'user@example.com',
    token: 'raw-login-token',
    now: new Date('2026-01-01T00:00:00.000Z'),
  };

  const expectAccept = path => {
    const link = buildLoginLinkData({ ...baseArgs, redirectUrl: path });
    assert.equal(link.redirectUrl, path, `expected ${JSON.stringify(path)} to be accepted`);
  };
  const expectReject = path => {
    const link = buildLoginLinkData({ ...baseArgs, redirectUrl: path });
    assert.equal(link.redirectUrl, null, `expected ${JSON.stringify(path)} to be rejected`);
  };

  expectAccept('/dashboard');
  expectAccept('/tenant-admin.html?tenant=acme');

  expectReject('//evil.com/path');           // protocol-relative
  expectReject('/\\evil.com/path');          // backslash variant some browsers normalise
  expectReject('https://evil.com');          // absolute URL, no leading slash
  expectReject('javascript:alert(1)');       // scheme attack
  expectReject('dashboard');                 // missing leading slash
  expectReject('');                          // empty
  expectReject(null);
  expectReject(undefined);
});
