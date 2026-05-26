const test = require('node:test');
const assert = require('node:assert/strict');

const {
  API_KEY_PREFIX,
  API_KEY_SCOPES,
  buildApiKeyData,
  generateApiKeyToken,
  hashApiKeyToken,
  isApiKeyActive,
  normalizeScopes,
  parseApiKeyAuthHeader,
} = require('../api/api-key-utils');

test('API_KEY_SCOPES exposes the documented scope set', () => {
  assert.deepEqual(
    [...API_KEY_SCOPES].sort(),
    [
      'comments:read',
      'comments:write',
      'suggestions:read',
      'suggestions:status',
      'suggestions:write',
    ].sort()
  );
});

test('generateApiKeyToken produces unique vt_live_ tokens', () => {
  const a = generateApiKeyToken();
  const b = generateApiKeyToken();
  assert.ok(a.startsWith(API_KEY_PREFIX), 'token must use the public live prefix');
  assert.ok(b.startsWith(API_KEY_PREFIX), 'token must use the public live prefix');
  assert.notEqual(a, b, 'consecutive tokens must differ');
  const body = a.slice(API_KEY_PREFIX.length);
  // base64url uses [A-Za-z0-9_-], no padding
  assert.ok(/^[A-Za-z0-9_-]+$/.test(body), 'token body must be base64url');
  assert.ok(body.length >= 32, 'token body must encode at least 32 bytes of entropy');
});

test('hashApiKeyToken is a deterministic 64-char sha256 hex digest', () => {
  const token = 'vt_live_example-token';
  const hash = hashApiKeyToken(token);
  assert.equal(hash.length, 64);
  assert.ok(/^[a-f0-9]+$/.test(hash), 'hash must be lowercase hex');
  assert.equal(hashApiKeyToken(token), hash, 'hashing is deterministic');
  assert.notEqual(hashApiKeyToken(token + 'x'), hash, 'different inputs hash differently');
});

test('parseApiKeyAuthHeader accepts only Bearer vt_live_ tokens', () => {
  assert.equal(parseApiKeyAuthHeader(undefined), null);
  assert.equal(parseApiKeyAuthHeader(''), null);
  assert.equal(parseApiKeyAuthHeader('vt_live_abc'), null, 'must require Bearer prefix');
  assert.equal(parseApiKeyAuthHeader('Bearer wrong_prefix_abc'), null, 'must require vt_live_ token');
  assert.equal(
    parseApiKeyAuthHeader('Bearer vt_live_abc '),
    'vt_live_abc',
    'trims trailing whitespace from the token'
  );
});

test('normalizeScopes drops unknown values, trims, and deduplicates', () => {
  assert.deepEqual(normalizeScopes(['suggestions:read', 'suggestions:read']), ['suggestions:read']);
  assert.deepEqual(
    normalizeScopes(['  suggestions:read ', 'suggestions:write', 'bogus:scope', 42, null]),
    ['suggestions:read', 'suggestions:write']
  );
  assert.deepEqual(normalizeScopes(null), []);
  assert.deepEqual(normalizeScopes('suggestions:read'), [], 'non-arrays return empty');
});

test('buildApiKeyData requires tenantId, name, and at least one scope', () => {
  assert.throws(
    () => buildApiKeyData({ tenantId: '', name: 'x', scopes: ['suggestions:read'], token: 'vt_live_a' }),
    /tenantId required/
  );
  assert.throws(
    () => buildApiKeyData({ tenantId: 't', name: '   ', scopes: ['suggestions:read'], token: 'vt_live_a' }),
    /name required/
  );
  assert.throws(
    () => buildApiKeyData({ tenantId: 't', name: 'Key', scopes: ['bogus'], token: 'vt_live_a' }),
    /at least one scope required/
  );
});

test('buildApiKeyData stores hashed token + safe prefix and never raw token', () => {
  const token = generateApiKeyToken();
  const now = new Date('2026-05-26T10:00:00.000Z');
  const data = buildApiKeyData({
    tenantId: 'tenant_abc',
    name: '  Claude Code lokal  ',
    scopes: ['suggestions:read', 'suggestions:write'],
    token,
    createdBy: 'owner@example.com',
    now,
  });

  assert.equal(data.tenantId, 'tenant_abc');
  assert.equal(data.name, 'Claude Code lokal', 'trims display name');
  assert.deepEqual(data.scopes, ['suggestions:read', 'suggestions:write']);
  assert.equal(data.tokenHash, hashApiKeyToken(token));
  assert.equal(data.tokenPrefix.startsWith(API_KEY_PREFIX), true);
  assert.equal(data.tokenPrefix.length, API_KEY_PREFIX.length + 6, 'prefix exposes only 6 token chars');
  assert.equal(data.tokenPrefix.includes(token.slice(-4)), false, 'prefix must not leak the tail');
  assert.equal(data.createdBy, 'owner@example.com');
  assert.equal(data.lastUsedAt, null);
  assert.equal(data.revokedAt, null);
  assert.deepEqual(data.createdAt, now);

  // Hardest invariant: the raw token must not appear anywhere in the persisted document.
  const serialized = JSON.stringify(data);
  assert.equal(
    serialized.includes(token),
    false,
    'raw token must never appear in the persisted API key document'
  );
});

test('isApiKeyActive flips to false once revokedAt is set', () => {
  assert.equal(isApiKeyActive({}), true);
  assert.equal(isApiKeyActive({ revokedAt: null }), true);
  assert.equal(isApiKeyActive({ revokedAt: new Date() }), false);
  assert.equal(isApiKeyActive({ revokedAt: '2026-05-01T00:00:00.000Z' }), false);
});
