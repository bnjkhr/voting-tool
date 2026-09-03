const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { functionBody } = require('./source-slice');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');

const {
  MAX_IMPORT_VOTES,
  formatTicketNumber,
  nextCounterValue,
  parseImportBlock,
  parseImportTicketNumber,
} = require('../lib/suggestion-import');

const BOARD = { ticketPrefix: 'FAM', name: 'FamilyManager' };

// ---------------------------------------------------------------------------
// Zählerfortschreibung — der Punkt, an dem ein Import am ehesten schiefgeht
// ---------------------------------------------------------------------------

test('Import von FAM-140 hebt den Zähler so an, dass der nächste reguläre Eintrag FAM-141 wird', () => {
  const { importData, error } = parseImportBlock({ import: { ticketNumber: 'FAM-140' } }, BOARD);
  assert.equal(error, undefined);
  assert.equal(importData.ticketNumber, 'FAM-140');
  assert.equal(importData.ticketNumberValue, 140);

  // Board hat regulär erst 4 Einträge -> Zähler steht auf 5.
  const nextAfterImport = nextCounterValue(5, importData.ticketNumberValue);
  assert.equal(nextAfterImport, 141);

  // Genau diesen Stand gibt der Generator als nächste Nummer aus.
  assert.equal(formatTicketNumber(BOARD.ticketPrefix, nextAfterImport), 'FAM-141');
});

test('ein kompletter Import von FAM-001..FAM-140 endet bei FAM-141', () => {
  let counter = 1;
  for (let n = 1; n <= 140; n += 1) {
    const { importData } = parseImportBlock(
      { import: { ticketNumber: formatTicketNumber('FAM', n) } },
      BOARD
    );
    counter = nextCounterValue(counter, importData.ticketNumberValue);
  }
  assert.equal(formatTicketNumber('FAM', counter), 'FAM-141');
});

test('der Zähler wird nie zurückgedreht', () => {
  // Import einer alten, niedrigen Nummer darf den Stand nicht senken.
  assert.equal(nextCounterValue(200, 41), 200);
  // Frisches Board ohne Counter-Dokument (undefined) startet bei 1.
  assert.equal(nextCounterValue(undefined, 7), 8);
  assert.equal(nextCounterValue(null, 1), 2);
});

// ---------------------------------------------------------------------------
// Ticketnummer-Validierung
// ---------------------------------------------------------------------------

test('Ticketnummern müssen zum Prefix des Boards passen', () => {
  assert.equal(parseImportTicketNumber('FAM-041', 'FAM').number, 41);
  // Klein geschrieben ist ok, das Prefix wird case-insensitiv verglichen.
  assert.equal(parseImportTicketNumber('fam-041', 'FAM').ticketNumber, 'fam-041');

  const foreign = parseImportTicketNumber('XYZ-041', 'FAM');
  assert.match(foreign.error, /Board-Prefix/);
});

test('unbrauchbare Ticketnummern werden abgewiesen', () => {
  ['', '   ', 'FAM', '-041', 'FAM-', 'FAM-0', 'FAM 041', 'TOOLONGPREFIX-1', 'FAM-abc']
    .forEach(value => {
      const result = parseImportTicketNumber(value, 'FAM');
      assert.ok(result.error, `erwartet: "${value}" wird abgewiesen`);
    });
  assert.ok(parseImportTicketNumber(41, 'FAM').error, 'Zahlen sind keine Ticketnummern');
  assert.ok(parseImportTicketNumber(null, 'FAM').error);
});

// ---------------------------------------------------------------------------
// Import-Block
// ---------------------------------------------------------------------------

test('parseImportBlock übernimmt ticketNumber, votes und createdAt', () => {
  const now = new Date('2026-09-03T10:00:00.000Z');
  const { importData, error } = parseImportBlock(
    { import: { ticketNumber: 'FAM-041', votes: 2, createdAt: '2026-04-30T09:12:00.000Z' } },
    BOARD,
    now
  );
  assert.equal(error, undefined);
  assert.equal(importData.ticketNumber, 'FAM-041');
  assert.equal(importData.votes, 2);
  assert.equal(importData.createdAt.toISOString(), '2026-04-30T09:12:00.000Z');
});

test('ohne import-Block bleibt alles beim Serververhalten', () => {
  assert.deepEqual(parseImportBlock({ title: 'Ohne Import' }, BOARD), { importData: null });
  assert.deepEqual(parseImportBlock({ import: null }, BOARD), { importData: null });
  assert.deepEqual(parseImportBlock(undefined, BOARD), { importData: null });
});

test('createdAt darf nicht in der Zukunft liegen', () => {
  const now = new Date('2026-09-03T10:00:00.000Z');
  const future = parseImportBlock({ import: { createdAt: '2026-09-03T10:00:01.000Z' } }, BOARD, now);
  assert.match(future.error, /Vergangenheit/);

  const past = parseImportBlock({ import: { createdAt: '2026-09-03T09:59:59.000Z' } }, BOARD, now);
  assert.equal(past.error, undefined);

  const broken = parseImportBlock({ import: { createdAt: 'kein Datum' } }, BOARD, now);
  assert.match(broken.error, /gültiges Datum/);
});

test('votes muss eine plausible ganze Zahl sein', () => {
  assert.equal(parseImportBlock({ import: { votes: 0 } }, BOARD).importData.votes, 0);
  ['2', 2.5, -1, MAX_IMPORT_VOTES + 1, NaN].forEach(value => {
    assert.ok(parseImportBlock({ import: { votes: value } }, BOARD).error, `erwartet abgewiesen: ${value}`);
  });
});

test('ein leerer oder falsch geformter import-Block ist ein 400', () => {
  assert.match(parseImportBlock({ import: {} }, BOARD).error, /mindestens eines der Felder/);
  assert.match(parseImportBlock({ import: [] }, BOARD).error, /muss ein Objekt sein/);
  assert.match(parseImportBlock({ import: 'FAM-041' }, BOARD).error, /muss ein Objekt sein/);
});

test('Notification-Adressen sind nicht importierbar', () => {
  const withNotification = {
    notificationEnabled: true,
    notificationEmail: 'jemand@example.com',
    import: { ticketNumber: 'FAM-041' },
  };
  assert.match(
    parseImportBlock(withNotification, BOARD).error,
    /Notification-Adressen können nicht importiert werden/
  );

  // Ohne Import-Block bleibt die normale Einreichung mit Benachrichtigung erlaubt.
  assert.deepEqual(
    parseImportBlock({ notificationEnabled: true, notificationEmail: 'jemand@example.com' }, BOARD),
    { importData: null }
  );
});

// ---------------------------------------------------------------------------
// Verdrahtung in api/index.js — die Arithmetik oben nützt nichts, wenn der
// Schreibpfad sie nicht benutzt.
// ---------------------------------------------------------------------------

test('der Generator formatiert über dieselbe Funktion wie der Import-Test', () => {
  assert.ok(
    apiSource.includes('return suggestionImport.formatTicketNumber(prefix, nextNumber);'),
    'generateTicketNumber muss formatTicketNumber nutzen — sonst testet der Round-Trip eine Kopie'
  );
});

test('Eindeutigkeit, Zähler-Bump und Anlage laufen in einer Transaktion', () => {
  const body = functionBody(apiSource, 'createSuggestionWithImportedTicketNumber');

  assert.ok(
    body.includes('nextNumber: suggestionImport.nextCounterValue('),
    'der Counter-Write muss über nextCounterValue laufen'
  );

  assert.ok(body.includes('db.runTransaction('), 'Import muss transaktional laufen');
  assert.ok(
    body.includes(".where('appId', '==', tenantApp.id)") && body.includes(".where('ticketNumber', '==', importData.ticketNumber)"),
    'Kollisionsprüfung muss auf Board + Ticketnummer filtern'
  );
  assert.ok(
    body.includes('getTenantId(doc.data() || {}) === tenantId'),
    'Kollisionsprüfung muss zusätzlich auf den Tenant scopen'
  );
  assert.ok(body.includes('status: 409'), 'Ticketnummer-Kollision muss 409 liefern');
  assert.ok(
    body.includes('counterUpdate.prefix = buildTicketPrefix('),
    'ein Counter ohne Prefix darf nicht zu "undefined-141" führen'
  );
});
