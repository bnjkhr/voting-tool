const crypto = require('crypto');

const API_KEY_PREFIX = 'vt_live_';
const API_KEY_TOKEN_BYTES = 32;

const API_KEY_SCOPES = [
  'suggestions:read',
  'suggestions:write',
  'suggestions:status',
  'comments:read',
  'comments:write',
];

function generateApiKeyToken() {
  return `${API_KEY_PREFIX}${crypto.randomBytes(API_KEY_TOKEN_BYTES).toString('base64url')}`;
}

function hashApiKeyToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function parseApiKeyAuthHeader(headerValue) {
  if (typeof headerValue !== 'string') return null;
  if (!headerValue.startsWith('Bearer ')) return null;
  const token = headerValue.slice('Bearer '.length).trim();
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  return token;
}

function normalizeScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  const seen = new Set();
  const result = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string') continue;
    const trimmed = scope.trim();
    if (!API_KEY_SCOPES.includes(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function buildApiKeyData({
  tenantId,
  name,
  scopes,
  token,
  createdBy = null,
  now = new Date(),
}) {
  if (!tenantId) throw new Error('tenantId required');
  const cleanedName = typeof name === 'string' ? name.trim().slice(0, 80) : '';
  if (!cleanedName) throw new Error('name required');
  const normalizedScopes = normalizeScopes(scopes);
  if (normalizedScopes.length === 0) throw new Error('at least one scope required');

  const createdAt = new Date(now);
  return {
    tenantId,
    name: cleanedName,
    scopes: normalizedScopes,
    tokenHash: hashApiKeyToken(token),
    tokenPrefix: token.slice(0, API_KEY_PREFIX.length + 6),
    createdAt,
    createdBy: createdBy || null,
    lastUsedAt: null,
    revokedAt: null,
  };
}

function isApiKeyActive(data = {}) {
  return !data.revokedAt;
}

module.exports = {
  API_KEY_PREFIX,
  API_KEY_SCOPES,
  buildApiKeyData,
  generateApiKeyToken,
  hashApiKeyToken,
  isApiKeyActive,
  normalizeScopes,
  parseApiKeyAuthHeader,
};
