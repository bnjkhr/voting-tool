const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  BOT_TENANT_NAME_PATTERN,
  maskEmail,
  parseArgs,
  partitionCandidates,
} = require('../scripts/cleanup-bot-tenants');

const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'cleanup-bot-tenants.js'), 'utf8');

test('Erkennungsmuster trifft Zufallsnamen, aber keine normalen Workspace-Namen', () => {
  const pattern = new RegExp(BOT_TENANT_NAME_PATTERN);
  assert.ok(pattern.test('xmUgopBzCxZxEIkKJV'));
  assert.equal(pattern.test('Acme Feedback'), false);
  assert.equal(pattern.test('FamilyManager'), false, 'unter 15 Zeichen');
  assert.equal(pattern.test('Muenchen-Software'), false);
});

test('parseArgs: Dry-Run ist der Default, --commit verlangt --expect', () => {
  assert.deepEqual(parseArgs([]), { commit: false, expect: null });
  assert.throws(() => parseArgs(['--commit']), /--expect/);
  assert.deepEqual(parseArgs(['--commit', '--expect=119']), { commit: true, expect: 119 });
});

test('partitionCandidates: Billing, Suggestions und echte Einzelwörter werden nie gelöscht', () => {
  const { targets, skipped } = partitionCandidates([
    { id: 'bot', name: 'xmUgopBzCxZxEIkKJV', has_billing: false, suggestions: 0 },
    { id: 'paid', name: 'xmUgopBzCxZxEIkKJV', has_billing: true, suggestions: 0 },
    { id: 'used', name: 'xmUgopBzCxZxEIkKJV', has_billing: false, suggestions: 3 },
    { id: 'praxis', name: 'Physiotherapiepraxis', has_billing: false, suggestions: 0 },
  ]);
  assert.deepEqual(targets.map((t) => t.id), ['bot']);
  assert.deepEqual(skipped.map((t) => [t.id, t.reason]), [
    ['paid', 'Billing'],
    ['used', '3 Suggestions'],
    ['praxis', 'Name wirkt nicht zufällig'],
  ]);
});

test('maskEmail gibt fremde Adressen nicht im Klartext aus', () => {
  assert.equal(maskEmail('jane.doe@yoobi.nl'), 'j***@yoobi.nl');
});

test('Dry-Run läuft read-only, activity wird ohne FK-Cascade explizit gelöscht', () => {
  assert.ok(source.includes("commit ? 'begin' : 'begin read only'"));
  assert.ok(source.includes('delete from activity where tenant_id = any($1)'));
  assert.ok(source.includes('delete from login_links where email = any($1::citext[])'));
});
