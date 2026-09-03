'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const { formatTicketNumber, DEFAULT_TICKET_PREFIX } = require('../lib/ticket-number');
const { buildTicketPrefix } = require('../api/tenant-provisioning');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const appsRepoSource = fs.readFileSync(path.join(rootDir, 'db/apps.js'), 'utf8');

test('formatTicketNumber: Prefix + auf 3 Stellen aufgefüllte Nummer', () => {
  assert.equal(formatTicketNumber('AV', 1), 'AV-001');
  assert.equal(formatTicketNumber('AV', 42), 'AV-042');
  assert.equal(formatTicketNumber('AV', 999), 'AV-999');
  // Vierstellig darf nicht abgeschnitten werden — padStart füllt nur auf.
  assert.equal(formatTicketNumber('AV', 1000), 'AV-1000');
  assert.equal(formatTicketNumber('ROADLIGHT', 7), 'ROADLIGHT-007');
});

test('formatTicketNumber: leerer/fehlender Prefix fällt auf denselben Default zurück wie buildTicketPrefix', () => {
  // Vor der Vereinheitlichung stand in db/apps.js 'TICKET', in
  // api/tenant-provisioning.js 'APP' — ein Board ohne ticket_prefix hätte je
  // nach Backend unterschiedliche Nummern bekommen.
  assert.equal(buildTicketPrefix('', ''), DEFAULT_TICKET_PREFIX);
  assert.equal(formatTicketNumber(null, 1), `${DEFAULT_TICKET_PREFIX}-001`);
  assert.equal(formatTicketNumber(undefined, 1), `${DEFAULT_TICKET_PREFIX}-001`);
  assert.equal(formatTicketNumber('', 1), `${DEFAULT_TICKET_PREFIX}-001`);
  assert.equal(formatTicketNumber('   ', 1), `${DEFAULT_TICKET_PREFIX}-001`);
  assert.notEqual(formatTicketNumber(null, 1), 'TICKET-001');
});

test('formatTicketNumber: Prefix wird getrimmt, aber sonst unverändert übernommen', () => {
  assert.equal(formatTicketNumber('  AV  ', 3), 'AV-003');
});

test('beide Backends erzeugen die Nummer über dieselbe Funktion (kein eigenes Format)', () => {
  // Firestore-Pfad (counters-Transaktion in api/index.js)
  assert.ok(
    apiSource.includes('formatTicketNumber(prefix, nextNumber)'),
    'der Firestore-Zweig muss über lib/ticket-number formatieren'
  );
  // Postgres-Pfad (atomarer Bump in db/apps.js)
  assert.ok(
    appsRepoSource.includes('formatTicketNumber(prefix, issued)'),
    'der Postgres-Zweig muss über lib/ticket-number formatieren'
  );
  // Kein eigenes Format mehr in den Backend-Pfaden — sonst driftet es wieder
  // auseinander, sobald einer der beiden angefasst wird.
  for (const [name, source] of [['api/index.js', apiSource], ['db/apps.js', appsRepoSource]]) {
    assert.equal(
      /padStart\(3, '0'\)/.test(source), false,
      `${name} darf das Ticketnummer-Format nicht selbst zusammenbauen`
    );
  }
});
