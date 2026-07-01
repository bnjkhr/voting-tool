const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const initSql = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '0001_init.sql'),
  'utf8'
);

const DOMAIN_TABLES = [
  'tenants', 'apps', 'releases', 'suggestions', 'votes', 'comments',
  'attachments', 'activity', 'users', 'memberships', 'invites',
  'sessions', 'login_links', 'api_keys',
];

test('init migration declares every domain table', () => {
  for (const t of DOMAIN_TABLES) {
    assert.ok(
      new RegExp(`create table ${t}\\b`).test(initSql),
      `migration must create table ${t}`
    );
  }
});

test('votes enforce one vote per fingerprint at the DB level', () => {
  assert.ok(
    /unique \(suggestion_id, user_fingerprint\)/.test(initSql),
    'votes must have a unique(suggestion_id, user_fingerprint) constraint'
  );
});

test('ticket counter is folded into apps (no separate counters table)', () => {
  assert.ok(/next_ticket_number\s+int/.test(initSql));
  assert.equal(/create table counters\b/.test(initSql), false, 'counters table should not exist');
});

test('tenant isolation: child tables reference tenants and cascade', () => {
  // Stichprobe an datentragenden Tabellen
  for (const t of ['apps', 'suggestions', 'votes', 'comments', 'memberships', 'api_keys']) {
    const block = initSql.slice(initSql.indexOf(`create table ${t} `));
    assert.ok(
      /references tenants\(id\) on delete cascade/.test(block.slice(0, block.indexOf(');'))),
      `${t} must reference tenants(id) on delete cascade`
    );
  }
});

test('screenshots are modelled as attachments, not inline blobs', () => {
  assert.ok(/create table attachments/.test(initSql));
  assert.equal(/screenshots\s+text\[\]/.test(initSql), false, 'no inline screenshots[] column');
});

test('billing columns are prepared on tenants for Stripe', () => {
  for (const col of ['stripe_customer_id', 'subscription_status', 'trial_ends_at', 'current_period_end', 'plan']) {
    assert.ok(new RegExp(`\\b${col}\\b`).test(initSql), `tenants should have ${col}`);
  }
});
