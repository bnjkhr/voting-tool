'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { COLUMNS, columnFor, statusFor, needsConfirm, buildBoard } = require('../public/board-model');

const TICKET_TYPES = ['ticket', 'bug'];

// Spaltentabelle der Spec: welche Status eine Spalte zeigt und was Ablegen setzt.
const TICKET_TABLE = {
  offen: { shows: ['neu', 'offen'], sets: 'offen' },
  arbeit: { shows: ['in Bearbeitung'], sets: 'in Bearbeitung' },
  test: { shows: ['im Test'], sets: 'im Test' },
  wartet: { shows: ['wartend'], sets: 'wartend' },
  fertig: { shows: ['gelöst'], sets: 'gelöst' },
};
const FEATURE_TABLE = {
  offen: { shows: ['neu', 'wird geprüft'], sets: 'wird geprüft' },
  arbeit: { shows: ['wird umgesetzt'], sets: 'wird umgesetzt' },
  test: { shows: ['im Test'], sets: 'im Test' },
  wartet: { shows: [], sets: null },
  fertig: { shows: ['ist umgesetzt'], sets: 'ist umgesetzt' },
};
const TABLES = [
  ...TICKET_TYPES.map((type) => [type, TICKET_TABLE]),
  ['feature', FEATURE_TABLE],
];

let nextId = 0;
function entry(fields = {}) {
  nextId += 1;
  return { id: `s${nextId}`, type: 'ticket', status: 'offen', approved: true, priority: 'mittel', labels: [], ...fields };
}

const titles = (column) => column.items.map((item) => item.title);

test('COLUMNS: fünf Spalten in fester Reihenfolge', () => {
  assert.deepEqual(COLUMNS, [
    { key: 'offen', label: 'Offen' },
    { key: 'arbeit', label: 'In Arbeit' },
    { key: 'test', label: 'Im Test' },
    { key: 'wartet', label: 'Wartet' },
    { key: 'fertig', label: 'Fertig' },
  ]);
});

for (const [type, table] of TABLES) {
  for (const [key, { shows, sets }] of Object.entries(table)) {
    test(`${type}: Spalte ${key} zeigt ${shows.join(', ') || 'nichts'}`, () => {
      for (const status of shows) {
        assert.equal(columnFor({ approved: true, type, status }), key, status);
      }
    });

    test(`${type}: Ablegen in ${key} setzt ${sets}`, () => {
      assert.equal(statusFor(key, type), sets);
      if (sets) assert.equal(columnFor({ approved: true, type, status: sets }), key);
    });
  }
}

test('statusFor: Feature kann nicht auf Wartet', () => {
  assert.equal(statusFor('wartet', 'feature'), null);
});

test('statusFor: unbekannte Spalte ergibt null', () => {
  assert.equal(statusFor('gibtsnicht', 'ticket'), null);
  assert.equal(statusFor('toString', 'ticket'), null);
});

test('columnFor: nicht freigegeben erscheint nie', () => {
  assert.equal(columnFor({ approved: false, status: 'neu' }), null);
  assert.equal(columnFor({ approved: false, type: 'ticket', status: 'in Bearbeitung' }), null);
  assert.equal(columnFor({ type: 'ticket', status: 'offen' }), null);
});

test('columnFor: geschlossen und wird nicht umgesetzt stehen nicht auf dem Board', () => {
  assert.equal(columnFor({ approved: true, type: 'ticket', status: 'geschlossen' }), null);
  assert.equal(columnFor({ approved: true, type: 'bug', status: 'geschlossen' }), null);
  assert.equal(columnFor({ approved: true, type: 'feature', status: 'wird nicht umgesetzt' }), null);
});

test('columnFor: unbekannter oder leerer Status steht in Offen', () => {
  assert.equal(columnFor({ approved: true, status: 'xyz' }), 'offen');
  assert.equal(columnFor({ approved: true, status: '' }), 'offen');
  assert.equal(columnFor({ approved: true }), 'offen');
  assert.equal(columnFor({ approved: true, type: 'ticket', status: 'constructor' }), 'offen');
  // Ein Status des anderen Typs ist für diesen Typ unbekannt.
  assert.equal(columnFor({ approved: true, type: 'feature', status: 'wartend' }), 'offen');
  assert.equal(columnFor({ approved: true, type: 'ticket', status: 'ist umgesetzt' }), 'offen');
});

test('needsConfirm: nur API-Einträge ohne Benachrichtigung gehen ohne Rückfrage', () => {
  assert.equal(needsConfirm({ userFingerprint: 'api:k1' }), false);
  assert.equal(needsConfirm({ userFingerprint: '1.2.3.4_abc' }), true);
  assert.equal(needsConfirm({}), true);
  assert.equal(needsConfirm({ userFingerprint: null }), true);
  assert.equal(needsConfirm({ userFingerprint: 'api:k1', notificationEnabled: true }), true);
});

test('buildBoard: liefert alle Spalten, auch leere', () => {
  const board = buildBoard([]);

  assert.deepEqual(Object.keys(board.columns), COLUMNS.map((column) => column.key));
  for (const column of Object.values(board.columns)) {
    assert.deepEqual(column, { items: [], total: 0 });
  }
  assert.equal(board.pendingCount, 0);
  assert.deepEqual(board.labels, []);
});

test('buildBoard: sortiert nach Priorität, dann Ticketnummer', () => {
  const board = buildBoard([
    entry({ title: 'niedrig', priority: 'niedrig', ticketNumber: 'TB-001' }),
    entry({ title: 'mittel 10', priority: 'mittel', ticketNumber: 'TB-010' }),
    entry({ title: 'kritisch', priority: 'kritisch', ticketNumber: 'TB-099' }),
    entry({ title: 'mittel 2', priority: 'mittel', ticketNumber: 'TB-002' }),
    entry({ title: 'hoch', priority: 'hoch', ticketNumber: 'TB-050' }),
  ]);

  assert.deepEqual(titles(board.columns.offen), ['kritisch', 'hoch', 'mittel 2', 'mittel 10', 'niedrig']);
});

test('buildBoard: Ticketnummern werden zahlenrichtig verglichen', () => {
  const board = buildBoard([
    entry({ title: '1000', ticketNumber: 'TB-1000' }),
    entry({ title: '999', ticketNumber: 'TB-999' }),
  ]);

  assert.deepEqual(titles(board.columns.offen), ['999', '1000']);
});

test('buildBoard: ohne Priorität wie mittel, ohne Ticketnummer ans Ende', () => {
  const board = buildBoard([
    entry({ title: 'ohne Nummer', priority: undefined }),
    entry({ title: 'niedrig', priority: 'niedrig', ticketNumber: 'TB-001' }),
    entry({ title: 'mit Nummer', ticketNumber: 'TB-002' }),
  ]);

  assert.deepEqual(titles(board.columns.offen), ['mit Nummer', 'ohne Nummer', 'niedrig']);
});

test('buildBoard: Fertig zeigt die 20 neuesten, neueste zuerst, total zählt alle', () => {
  const day = (n) => `2026-01-${String(n).padStart(2, '0')}T12:00:00.000Z`;
  const done = Array.from({ length: 25 }, (_, index) => entry({
    title: `Tag ${index + 1}`,
    status: 'gelöst',
    ticketNumber: `TB-${index + 1}`,
    tagUpdatedAt: day(index + 1),
    // Ein altes Anlagedatum darf tagUpdatedAt nicht überstimmen.
    createdAt: day(28 - index),
  }));
  // Reihenfolge der Eingabe darf keine Rolle spielen.
  const board = buildBoard([...done.slice(12), ...done.slice(0, 12)]);

  assert.equal(board.columns.fertig.total, 25);
  assert.deepEqual(
    titles(board.columns.fertig),
    Array.from({ length: 20 }, (_, index) => `Tag ${25 - index}`),
  );
});

test('buildBoard: in Fertig zählt das Datum, nicht Priorität oder Nummer', () => {
  const done = (title, day, fields) => entry({ title, status: 'gelöst', tagUpdatedAt: `2026-02-0${day}T12:00:00Z`, ...fields });
  const board = buildBoard([
    done('alt, kritisch', 1, { priority: 'kritisch', ticketNumber: 'TB-001' }),
    done('neu, niedrig', 3, { priority: 'niedrig', ticketNumber: 'TB-003' }),
    done('mitte', 2, { ticketNumber: 'TB-002' }),
  ]);

  assert.deepEqual(titles(board.columns.fertig), ['neu, niedrig', 'mitte', 'alt, kritisch']);
});

test('buildBoard: gleiche oder fehlende Daten in Fertig ordnen sich nach Priorität und Nummer', () => {
  const done = (title, fields) => entry({ title, status: 'gelöst', ...fields });
  const same = '2026-02-01T12:00:00Z';
  const board = buildBoard([
    done('ohne Datum 2', { ticketNumber: 'TB-004' }),
    done('gleich 2', { tagUpdatedAt: same, ticketNumber: 'TB-002' }),
    done('ohne Datum 1', { ticketNumber: 'TB-003' }),
    done('gleich 1', { tagUpdatedAt: same, ticketNumber: 'TB-001' }),
  ]);

  assert.deepEqual(titles(board.columns.fertig), ['gleich 1', 'gleich 2', 'ohne Datum 1', 'ohne Datum 2']);
});

test('buildBoard: Fertig versteht Firestore-Zeitstempel und nimmt ersatzweise createdAt', () => {
  const old = Array.from({ length: 19 }, (_, index) => entry({
    title: `mittel ${index}`, status: 'gelöst', tagUpdatedAt: { _seconds: 2000 + index },
  }));
  const board = buildBoard([
    ...old,
    entry({ title: 'zu alt', status: 'gelöst', tagUpdatedAt: { seconds: 10 } }),
    entry({ title: 'nur angelegt', status: 'gelöst', createdAt: { _seconds: 5000 } }),
    entry({ title: 'ohne Datum', status: 'gelöst' }),
  ]);

  assert.equal(board.columns.fertig.total, 22);
  assert.ok(titles(board.columns.fertig).includes('nur angelegt'));
  assert.equal(titles(board.columns.fertig).includes('zu alt'), false);
  assert.equal(titles(board.columns.fertig).includes('ohne Datum'), false);
});

test('buildBoard: die Grenze von 20 gilt nur für Fertig', () => {
  const board = buildBoard(Array.from({ length: 25 }, () => entry()));

  assert.equal(board.columns.offen.items.length, 25);
  assert.equal(board.columns.offen.total, 25);
});

const MIXED = [
  entry({ title: 'A Ben', appId: 'a', labels: ['Ben', 'Zebra'] }),
  entry({ title: 'A ohne', appId: 'a' }),
  entry({ title: 'B Ben', appId: 'b', labels: ['Ben', 'Äpfel'] }),
  entry({ title: 'A wartet auf Freigabe', appId: 'a', approved: false, status: 'neu', labels: ['Neu'] }),
  entry({ title: 'B wartet auf Freigabe', appId: 'b', approved: false, status: 'neu', labels: ['Ben'] }),
  entry({ title: 'A geschlossen', appId: 'a', status: 'geschlossen', labels: undefined }),
];

test('buildBoard: nicht freigegebene fehlen und werden nur gezählt', () => {
  const board = buildBoard(MIXED);
  const shown = Object.values(board.columns).flatMap(titles);

  assert.deepEqual(shown.sort(), ['A Ben', 'A ohne', 'B Ben']);
  assert.equal(board.pendingCount, 2);
});

for (const [filter, shown, pending] of [
  [{ appId: 'a' }, ['A Ben', 'A ohne'], 1],
  [{ label: 'Ben' }, ['A Ben', 'B Ben'], 1],
  [{ appId: 'b', label: 'Ben' }, ['B Ben'], 1],
  [{ appId: 'a', label: 'Ben' }, ['A Ben'], 0],
  [{ appId: '', label: '' }, ['A Ben', 'A ohne', 'B Ben'], 2],
]) {
  test(`buildBoard: Filter ${JSON.stringify(filter)}`, () => {
    const board = buildBoard(MIXED, filter);

    assert.deepEqual(Object.values(board.columns).flatMap(titles).sort(), shown);
    assert.equal(board.columns.offen.total, shown.length);
    assert.equal(board.pendingCount, pending);
  });
}

test('buildBoard: labels sind sortiert, eindeutig und unabhängig vom Filter', () => {
  const expected = ['Äpfel', 'Ben', 'Neu', 'Zebra'];

  assert.deepEqual(buildBoard(MIXED).labels, expected);
  assert.deepEqual(buildBoard(MIXED, { appId: 'b', label: 'Ben' }).labels, expected);
});

test('buildBoard: verändert die Eingabe nicht', () => {
  const items = [entry({ title: 'zweiter', ticketNumber: 'TB-2' }), entry({ title: 'erster', ticketNumber: 'TB-1' })];

  buildBoard(items);

  assert.deepEqual(items.map((item) => item.title), ['zweiter', 'erster']);
});
