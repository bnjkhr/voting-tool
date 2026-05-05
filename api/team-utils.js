const crypto = require('crypto');

const MEMBERSHIP_ROLES = ['owner', 'admin', 'viewer'];
const MEMBERSHIP_STATUSES = ['active', 'disabled'];
const INVITE_STATUSES = ['pending', 'accepted', 'revoked', 'expired'];

function normalizeInviteEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Invalid invite email');
  }
  return email;
}

function normalizeMembershipRole(value) {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return MEMBERSHIP_ROLES.includes(role) ? role : 'viewer';
}

function buildInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function buildInviteTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function buildTenantInviteData({
  tenantId,
  email,
  role,
  token,
  now = new Date(),
  expiresInDays = 7,
}) {
  const createdAt = new Date(now);
  const expiresAt = new Date(createdAt);
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  return {
    tenantId,
    email: normalizeInviteEmail(email),
    role: normalizeMembershipRole(role),
    status: 'pending',
    tokenHash: buildInviteTokenHash(token),
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    acceptedAt: null,
  };
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  if (value._seconds !== undefined) return new Date(value._seconds * 1000);
  if (value.seconds !== undefined) return new Date(value.seconds * 1000);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isInviteExpired(invite = {}, now = new Date()) {
  const expiresAt = toDate(invite.expiresAt);
  if (!expiresAt) return true;
  return expiresAt.getTime() <= new Date(now).getTime();
}

function cleanDisplayName(value, fallback = '') {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return cleaned || fallback;
}

function buildUserData({ email, displayName, now = new Date() }) {
  const normalizedEmail = normalizeInviteEmail(email);
  return {
    email: normalizedEmail,
    displayName: cleanDisplayName(displayName, normalizedEmail),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function buildMembershipData({ tenantId, userId, role, now = new Date() }) {
  return {
    tenantId,
    userId,
    role: normalizeMembershipRole(role),
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function buildSessionData({
  userId,
  token,
  now = new Date(),
  expiresInDays = 30,
}) {
  const createdAt = new Date(now);
  const expiresAt = new Date(createdAt);
  expiresAt.setDate(expiresAt.getDate() + expiresInDays);

  return {
    userId,
    status: 'active',
    tokenHash: buildInviteTokenHash(token),
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: createdAt,
    expiresAt,
  };
}

function isSessionExpired(session = {}, now = new Date()) {
  const expiresAt = toDate(session.expiresAt);
  if (!expiresAt) return true;
  return expiresAt.getTime() <= new Date(now).getTime();
}

function buildLoginLinkData({
  email,
  token,
  redirectUrl = null,
  now = new Date(),
  expiresInMinutes = 15,
}) {
  const createdAt = new Date(now);
  const expiresAt = new Date(createdAt.getTime() + expiresInMinutes * 60 * 1000);

  return {
    email: normalizeInviteEmail(email),
    status: 'pending',
    tokenHash: buildInviteTokenHash(token),
    createdAt,
    updatedAt: createdAt,
    expiresAt,
    redirectUrl: typeof redirectUrl === 'string' && redirectUrl.startsWith('/') ? redirectUrl : null,
    consumedAt: null,
  };
}

function isLoginLinkExpired(loginLink = {}, now = new Date()) {
  const expiresAt = toDate(loginLink.expiresAt);
  if (!expiresAt) return true;
  return expiresAt.getTime() <= new Date(now).getTime();
}

module.exports = {
  INVITE_STATUSES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  buildLoginLinkData,
  buildMembershipData,
  buildInviteToken,
  buildInviteTokenHash,
  buildSessionData,
  buildTenantInviteData,
  buildUserData,
  isInviteExpired,
  isLoginLinkExpired,
  isSessionExpired,
  normalizeInviteEmail,
  normalizeMembershipRole,
};
