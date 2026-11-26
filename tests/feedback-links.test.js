'use strict';

// Reine Logik fürs Holen: Startstatus, Auswahl, Kürzen, Abgleich, Links.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FEEDBACK_LABEL,
  FEEDBACK_FINGERPRINT,
  DESCRIPTION_LIMIT,
  TRUNCATION_NOTE,
  LEGACY_BOARD_BASE,
  startStatusFor,
  isFetchable,
  buildTicketFromEntry,
  planFetch,
  legacyBoardUrl,
} = require('../lib/feedback-links');

const RESOLVED = ['ist umgesetzt', 'wird nicht umgesetzt', 'gelöst', 'geschlossen'];

const entry = (id, overrides = {}) => ({
  id, type: 'feature', status: 'wird geprüft', approved: true,
  title: `Titel ${id}`, description: `Text ${id}`, ...overrides,
});

test('Konstanten', () => {
  assert.equal(FEEDBACK_LABEL, 'Feedback');
  assert.equal(FEEDBACK_FINGERPRINT, 'api:feedback');
  assert.equal(DESCRIPTION_LIMIT, 1000);
  assert.equal(TRUNCATION_NOTE, '\n\n[Gekürzt. Der ganze Text steht im öffentlichen Eintrag.]');
});

for (const [publicStatus, start] of [
  ['neu', 'neu'],
  ['offen', 'neu'],
  ['wird geprüft', 'neu'],
  ['in Bearbeitung', 'in Bearbeitung'],
  ['wird umgesetzt', 'in Bearbeitung'],
  ['im Test', 'im Test'],
  ['wartend', 'wartend'],
  ['xyz', 'neu'],
  [undefined, 'neu'],
  ['toString', 'neu'],
]) {
  test(`Startstatus ${publicStatus} -> ${start}`, () => {
    assert.equal(startStatusFor(publicStatus), start);
  });
}

test('isFetchable: freigegeben und offen', () => {
  assert.equal(isFetchable(entry('a'), RESOLVED), true);
});

for (const [why, overrides] of [
  ['nicht freigegeben', { approved: false }],
  ['Freigabe fehlt', { approved: undefined }],
  ['Freigabe als Text', { approved: 'true' }],
  ...RESOLVED.map((status) => [status, { status }]),
]) {
  test(`isFetchable: ${why} -> nein`, () => {
    assert.equal(isFetchable(entry('a', overrides), RESOLVED), false);
  });
}

test('Ticket aus einem Eintrag', () => {
  assert.deepEqual(buildTicketFromEntry(entry('a', { priority: 'hoch', status: 'wird umgesetzt' })), {
    type: 'ticket',
    title: 'Titel a',
    description: 'Text a',
    priority: 'hoch',
    status: 'in Bearbeitung',
    labels: ['Feedback'],
    approved: true,
    userFingerprint: 'api:feedback',
    notificationEnabled: false,
    notificationEmail: null,
  });
});

test('Beschreibung bis 1.000 Zeichen bleibt, darüber wird gekürzt', () => {
  const exact = 'a'.repeat(DESCRIPTION_LIMIT);
  assert.equal(buildTicketFromEntry(entry('a', { description: exact })).description, exact);

  const long = buildTicketFromEntry(entry('a', { description: `${exact}b` })).description;
  assert.equal(long.length, DESCRIPTION_LIMIT + TRUNCATION_NOTE.length);
  assert.ok(long.endsWith(TRUNCATION_NOTE));
  assert.equal(long.includes('b'), false);
});

test('Titel wird auf 100 Zeichen gekürzt', () => {
  assert.equal(buildTicketFromEntry(entry('a', { title: 'x'.repeat(101) })).title, 'x'.repeat(100));
});

test('Kürzen zerteilt kein Zeichen, und Nullzeichen fallen weg', () => {
  const ticket = buildTicketFromEntry(entry('a', {
    title: `${'x'.repeat(99)}😀`,
    description: `a\u0000b${'y'.repeat(997)}😀`,
  }));

  assert.equal(ticket.title, 'x'.repeat(99));
  assert.equal(ticket.description, `ab${'y'.repeat(997)}${TRUNCATION_NOTE}`);
});

test('Fehlende Texte ergeben leere Beschreibung und einen Ersatztitel', () => {
  const ticket = buildTicketFromEntry(entry('a', { title: '  ', description: undefined }));

  assert.equal(ticket.title, 'Ohne Titel');
  assert.equal(ticket.description, '');
});

test('Nichts von der einreichenden Person landet im Ticket', () => {
  const secrets = {
    notificationEmail: 'person@example.test',
    userFingerprint: '203.0.113.7_abdruck',
    screenshots: ['data:image/png;base64,GEHEIMBILD'],
    attachments: [{ url: 'https://example.test/anhang' }],
    environment: { platform: 'GEHEIMPLATTFORM', appVersion: '9.9.9-geheim' },
    stepsToReproduce: 'GEHEIMSCHRITTE',
    expectedBehavior: 'GEHEIMERWARTUNG',
    actualBehavior: 'GEHEIMVERHALTEN',
    createdBy: 'GEHEIMNAME',
  };

  const ticket = buildTicketFromEntry(entry('a', { type: 'bug', notificationEnabled: true, ...secrets }));
  const text = JSON.stringify(ticket);

  for (const value of [
    'person@example.test', '203.0.113.7', 'GEHEIMBILD', 'example.test/anhang', 'GEHEIMPLATTFORM',
    '9.9.9-geheim', 'GEHEIMSCHRITTE', 'GEHEIMERWARTUNG', 'GEHEIMVERHALTEN', 'GEHEIMNAME',
  ]) {
    assert.equal(text.includes(value), false, value);
  }
  assert.equal(ticket.userFingerprint, 'api:feedback');
  assert.equal(ticket.notificationEnabled, false);
  assert.equal(ticket.notificationEmail, null);
});

test('Priorität: nur gültige bleiben', () => {
  for (const priority of ['niedrig', 'mittel', 'hoch', 'kritisch']) {
    assert.equal(buildTicketFromEntry(entry('a', { priority })).priority, priority);
  }
  for (const priority of ['dringend', '', undefined, 3]) {
    assert.equal(buildTicketFromEntry(entry('a', { priority })).priority, null);
  }
});

test('planFetch: neu anlegen nur, was freigegeben, offen und unbekannt ist', () => {
  const plan = planFetch({
    entries: [
      entry('neu'),
      entry('verknuepft', { status: 'ist umgesetzt', type: 'bug' }),
      entry('grabstein'),
      entry('erledigt', { status: 'gelöst' }),
      entry('wartet', { approved: false }),
      entry('wartet2', { approved: undefined, status: 'neu' }),
      entry('zurueckgezogen', { approved: false }),
    ],
    links: [
      { id: 'l1', entryId: 'verknuepft', suggestionId: 's1' },
      { id: 'l2', entryId: 'grabstein', suggestionId: null },
      { id: 'l3', entryId: 'zurueckgezogen', suggestionId: 's3' },
      { id: 'l4', entryId: 'fehlt', suggestionId: 's4' },
    ],
    resolvedStatuses: RESOLVED,
  });

  assert.deepEqual(plan.toCreate.map((item) => item.id), ['neu']);
  assert.deepEqual(plan.refresh, [
    { linkId: 'l1', publicStatus: 'ist umgesetzt', publicType: 'bug', publicApproved: true, publicDeleted: false },
    { linkId: 'l2', publicStatus: 'wird geprüft', publicType: 'feature', publicApproved: true, publicDeleted: false },
    { linkId: 'l3', publicStatus: 'wird geprüft', publicType: 'feature', publicApproved: false, publicDeleted: false },
  ]);
  assert.deepEqual(plan.missing, ['l4']);
  assert.equal(plan.unapprovedCount, 3);
});

test('legacyBoardUrl führt aufs alte Board und kodiert wie buildUrlState', () => {
  assert.equal(LEGACY_BOARD_BASE, 'https://votingtool.benkohler.de');
  assert.equal(legacyBoardUrl('a b'), 'https://votingtool.benkohler.de/?appId=a+b');
});
