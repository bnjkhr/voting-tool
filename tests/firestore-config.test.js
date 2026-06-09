const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const rules = fs.readFileSync(path.join(rootDir, 'firestore.rules'), 'utf8');
const indexes = JSON.parse(fs.readFileSync(path.join(rootDir, 'firestore.indexes.json'), 'utf8'));
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(rootDir, 'firebase.json'), 'utf8'));

// ---------------------------------------------------------------------------
// firebase.json wires rules + indexes together so `firebase deploy` is enough.
// ---------------------------------------------------------------------------

test('firebase.json wires rules and indexes for deploy', () => {
  assert.equal(firebaseConfig.firestore?.rules, 'firestore.rules');
  assert.equal(firebaseConfig.firestore?.indexes, 'firestore.indexes.json');
});

// ---------------------------------------------------------------------------
// firestore.rules — defense-in-depth against direct client reads of tenant data.
// ---------------------------------------------------------------------------

test('legacy reads are kept for backwards compatibility but scoped to the legacy tenant only', () => {
  // apps + releases: legacy only
  assert.ok(
    rules.includes("match /apps/{appId}") &&
      /allow read:\s*if resource\.data\.tenantId == 'legacy';/.test(rules.split('match /apps')[1]),
    'apps reads must require tenantId == legacy'
  );
  assert.ok(
    rules.includes("match /releases/{releaseId}") &&
      /allow read:\s*if resource\.data\.tenantId == 'legacy';/.test(rules.split('match /releases')[1]),
    'releases reads must require tenantId == legacy'
  );

  // suggestions: legacy + approved (matches the old public board contract)
  const suggestionsBlock = rules.split('match /suggestions')[1] || '';
  assert.ok(
    /allow read:\s*if resource\.data\.tenantId == 'legacy'\s*\n?\s*&&\s*resource\.data\.approved == true;/.test(
      suggestionsBlock
    ),
    'suggestions reads must require tenantId == legacy AND approved == true'
  );
});

test('all SaaS-only collections are server-only via Admin SDK', () => {
  const serverOnly = [
    'tenants',
    'memberships',
    'users',
    'sessions',
    'invites',
    'loginLinks',
    'apiKeys',
    'userSettings',
    'votes',
    'comments',
    'activity',
    'counters',
  ];

  for (const collection of serverOnly) {
    const matcher = new RegExp(`match\\s+/${collection}/\\{[^}]+\\}\\s*\\{\\s*allow read,\\s*write:\\s*if false;`);
    assert.ok(
      matcher.test(rules),
      `collection ${collection} must be explicitly server-only (allow read, write: if false)`
    );
  }
});

test('rules end with a default-deny fallback for unknown collections', () => {
  assert.ok(
    /match\s+\/\{document=\*\*\}\s*\{\s*allow read,\s*write:\s*if false;\s*\}\s*\}/.test(rules),
    'rules must default-deny via /{document=**}'
  );
});

test('no collection allows direct client writes from the browser', () => {
  // The only `allow write` occurrences must be the explicit `if false` denies.
  const writeAllows = rules.match(/allow write:\s*if [^;]+;/g) || [];
  for (const line of writeAllows) {
    assert.ok(
      /allow write:\s*if false;/.test(line),
      `direct client writes must always be denied — found: ${line}`
    );
  }
});

// ---------------------------------------------------------------------------
// firestore.indexes.json — declared so production queries can't degrade to
// silent runtime failures when Firebase asks for missing composite indexes.
// ---------------------------------------------------------------------------

function hasIndex(collection, fieldNames) {
  return (indexes.indexes || []).some(idx => {
    if (idx.collectionGroup !== collection) return false;
    if (idx.queryScope && idx.queryScope !== 'COLLECTION') return false;
    const actual = (idx.fields || []).map(f => f.fieldPath);
    if (actual.length !== fieldNames.length) return false;
    return fieldNames.every((name, i) => actual[i] === name);
  });
}

test('composite indexes cover the duplicate-vote checks (legacy + tenant)', () => {
  // Voting-hot path: prevent duplicate votes per user/suggestion (legacy schema).
  assert.ok(
    hasIndex('votes', ['suggestionId', 'userFingerprint']),
    'votes must be indexed on (suggestionId, userFingerprint) for legacy duplicate-vote checks'
  );
  // Tenant-scoped variant introduced with multi-tenancy.
  assert.ok(
    hasIndex('votes', ['tenantId', 'suggestionId', 'userFingerprint']),
    'votes must be indexed on (tenantId, suggestionId, userFingerprint) for tenant-scoped duplicate-vote checks'
  );
});

test('composite indexes cover membership and invite lookups', () => {
  assert.ok(
    hasIndex('memberships', ['userId', 'status']),
    'memberships must be indexed on (userId, status) for session resolution'
  );
  assert.ok(
    hasIndex('memberships', ['tenantId', 'userId', 'status']),
    'memberships must be indexed on (tenantId, userId, status) for tenant-scoped access checks'
  );
  assert.ok(
    hasIndex('memberships', ['tenantId', 'role', 'status']),
    'memberships must be indexed on (tenantId, role, status) for the last-owner guard'
  );
  assert.ok(
    hasIndex('invites', ['tenantId', 'email', 'status']),
    'invites must be indexed on (tenantId, email, status) for duplicate-invite detection'
  );
  assert.ok(
    hasIndex('invites', ['tenantId', 'status']),
    'invites must be indexed on (tenantId, status) for pending-invite listings'
  );
});

test('composite indexes cover release + suggestion filtering', () => {
  assert.ok(
    hasIndex('releases', ['appId', 'status']),
    'releases must be indexed on (appId, status) for status-filtered listings'
  );
  assert.ok(
    hasIndex('suggestions', ['appId', 'approved']),
    'suggestions must be indexed on (appId, approved) for the public board feed'
  );
});

test('composite index covers session token lookup', () => {
  assert.ok(
    hasIndex('sessions', ['tokenHash', 'status']),
    'sessions must be indexed on (tokenHash, status) for /api/auth/session'
  );
});

test('every declared index uses ASCENDING order and is collection-scoped', () => {
  for (const idx of indexes.indexes || []) {
    assert.equal(
      idx.queryScope || 'COLLECTION',
      'COLLECTION',
      `index for ${idx.collectionGroup} must stay collection-scoped, not COLLECTION_GROUP`
    );
    for (const field of idx.fields || []) {
      assert.equal(
        field.order,
        'ASCENDING',
        `field ${field.fieldPath} on ${idx.collectionGroup} must be ASCENDING (none of our queries reverse-iterate)`
      );
    }
  }
});
