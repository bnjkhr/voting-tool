'use strict';

// Entscheidungen fürs Zurückschreiben: Zielstatus, Rückschritt, Mail ja/nein.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  TEST_STATUS, PUSH_MESSAGES, targetFor, isBackward, decidePush, legacyStatus,
  legacyMailAddress, legacyMailRecipient, workspaceMailAddress, workspaceMailRecipient,
} = require('../lib/feedback-push');

// Intern -> öffentlich (Ticket und Bug, Feature). null: keine Änderung.
const TARGETS = [
  ['in Bearbeitung', 'in Bearbeitung', 'wird umgesetzt'],
  ['wird umgesetzt', 'in Bearbeitung', 'wird umgesetzt'],
  ['gelöst', 'gelöst', 'ist umgesetzt'],
  ['ist umgesetzt', 'gelöst', 'ist umgesetzt'],
  ['im Test', null, null],
  ['neu', null, null],
  ['offen', null, null],
  ['wartend', null, null],
  ['geschlossen', null, null],
  ['wird geprüft', null, null],
  ['wird nicht umgesetzt', null, null],
];

for (const [internal, ticket, feature] of TARGETS) {
  test(`Zielstatus für intern „${internal}“`, () => {
    assert.equal(targetFor(internal, 'ticket'), ticket);
    assert.equal(targetFor(internal, 'bug'), ticket);
    assert.equal(targetFor(internal, 'feature'), feature);
  });
}

test('die Tabelle deckt jeden Status der API ab', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  const list = (name) => [...source.match(new RegExp(`^const ${name} = \\[([^\\]]*)\\];`, 'm'))[1]
    .matchAll(/'([^']*)'/g)].map(([, status]) => status);
  const all = new Set([...list('TICKET_STATUSES'), ...list('FEATURE_STATUSES')]);

  assert.deepEqual(TARGETS.map(([internal]) => internal).sort(), [...all].sort());
});

test('„im Test“ nur auf Wunsch', () => {
  assert.equal(TEST_STATUS, 'im Test');
  for (const type of ['ticket', 'bug', 'feature']) {
    assert.equal(targetFor('im Test', type), null);
    assert.equal(targetFor('im Test', type, { explicitTest: true }), 'im Test');
    // Der Wunsch gilt nur für „im Test“.
    assert.equal(targetFor('offen', type, { explicitTest: true }), null);
  }
});

test('unbekannter Typ zählt wie ein Ticket, unbekannter Status ändert nichts', () => {
  assert.equal(targetFor('gelöst', null), 'gelöst');
  assert.equal(targetFor('erfunden', 'ticket'), null);
  assert.equal(targetFor('constructor', 'ticket'), null);
  assert.equal(targetFor(undefined, 'ticket'), null);
});

for (const [type, current, target] of [
  ['ticket', 'gelöst', 'in Bearbeitung'],
  ['bug', 'im Test', 'in Bearbeitung'],
  ['bug', 'wartend', 'neu'],
  ['ticket', 'geschlossen', 'gelöst'],
  ['ticket', 'gelöst', 'im Test'],
  ['feature', 'ist umgesetzt', 'wird umgesetzt'],
  ['feature', 'wird nicht umgesetzt', 'ist umgesetzt'],
  ['feature', 'im Test', 'wird umgesetzt'],
  ['ticket', 'erfunden', 'gelöst'],
  ['ticket', null, 'gelöst'],
  ['ticket', 'toString', 'gelöst'],
]) {
  test(`Rückschritt (${type}): ${current} -> ${target}`, () => {
    assert.equal(isBackward(current, target, type), true);
  });
}

for (const [type, current, target] of [
  ['ticket', 'neu', 'in Bearbeitung'],
  ['bug', 'offen', 'gelöst'],
  ['bug', 'wartend', 'in Bearbeitung'],
  ['ticket', 'in Bearbeitung', 'im Test'],
  ['ticket', 'im Test', 'gelöst'],
  ['feature', 'wird geprüft', 'wird umgesetzt'],
  ['feature', 'neu', 'im Test'],
  ['feature', 'im Test', 'ist umgesetzt'],
  ['ticket', 'gelöst', 'gelöst'],
]) {
  test(`kein Rückschritt (${type}): ${current} -> ${target}`, () => {
    assert.equal(isBackward(current, target, type), false);
  });
}

const decide = (internalStatus, status, extra = {}) => decidePush({
  internalStatus, entry: { type: 'ticket', status }, mail: false, ...extra,
});

test('Entscheidung: schreiben, warten, nichts', () => {
  assert.deepEqual(decide('gelöst', 'offen'), { action: 'write', target: 'gelöst' });
  assert.deepEqual(decide('offen', 'gelöst'), { action: 'clear', target: null });
  assert.deepEqual(decide('gelöst', 'gelöst'), { action: 'none', target: 'gelöst' });
  assert.deepEqual(decide('gelöst', 'gelöst', { mail: true }), { action: 'none', target: 'gelöst' });
  assert.deepEqual(decide('in Bearbeitung', 'gelöst'),
    { action: 'wait', target: 'in Bearbeitung', reason: 'backward' });
  assert.deepEqual(decide('gelöst', 'offen', { mail: true }), { action: 'wait', target: 'gelöst', reason: 'mail' });
  // Mail geht vor Rückschritt: Der Knopf muss die Mail nennen.
  assert.deepEqual(decide('in Bearbeitung', 'gelöst', { mail: true }),
    { action: 'wait', target: 'in Bearbeitung', reason: 'mail' });
});

test('Entscheidung: „im Test“ auf Wunsch wartet bei Mail genauso', () => {
  assert.deepEqual(decide('im Test', 'offen'), { action: 'clear', target: null });
  assert.deepEqual(decide('im Test', 'offen', { explicitTest: true }), { action: 'write', target: 'im Test' });
  assert.deepEqual(decide('im Test', 'offen', { explicitTest: true, mail: true }),
    { action: 'wait', target: 'im Test', reason: 'mail' });
  assert.deepEqual(decide('im Test', 'gelöst', { explicitTest: true }),
    { action: 'wait', target: 'im Test', reason: 'backward' });
});

test('Entscheidung richtet sich nach dem Typ des öffentlichen Eintrags', () => {
  const result = decidePush({
    internalStatus: 'in Bearbeitung', entry: { type: 'feature', status: 'wird geprüft' }, mail: false,
  });
  assert.deepEqual(result, { action: 'write', target: 'wird umgesetzt' });
});

// Alte Einträge ohne `status` haben nur ein Kennzeichen, und das ist gröber.
test('Kennzeichen allein: im Zweifel zählt der höhere Rang', () => {
  assert.deepEqual(
    legacyStatus({ tag: 'in analyse' }, 'bug', 'in Bearbeitung'),
    { status: 'in Bearbeitung', rankStatus: 'im Test' }
  );
  assert.deepEqual(
    legacyStatus({ tag: ' Im Test ' }, 'feature', 'wird geprüft'),
    { status: 'im Test', rankStatus: 'im Test' }
  );
  assert.deepEqual(
    legacyStatus({ tag: 'behoben' }, 'ticket', 'gelöst'),
    { status: 'gelöst', rankStatus: 'gelöst' }
  );
  // Mit `status` zählt allein der.
  assert.deepEqual(
    legacyStatus({ status: 'in Bearbeitung', tag: 'in analyse' }, 'bug', 'in Bearbeitung'),
    { status: 'in Bearbeitung', rankStatus: 'in Bearbeitung' }
  );
  const entry = { type: 'bug', ...legacyStatus({ tag: 'in analyse' }, 'bug', 'in Bearbeitung') };
  assert.equal(decidePush({ internalStatus: 'im Test', entry, mail: false, explicitTest: true }).action, 'write');
  assert.equal(decidePush({ internalStatus: 'gelöst', entry, mail: false }).action, 'write');
  const waiting = { type: 'bug', status: 'in Bearbeitung', rankStatus: 'im Test' };
  assert.equal(isBackward(waiting.rankStatus, 'in Bearbeitung', 'bug'), true);
});

const MAIL = 'person@example.test';
const SETTINGS = { notificationsEnabled: true, email: 'einstellung@example.test' };

for (const [name, entry, settings, expected] of [
  ['Benachrichtigung am Eintrag', { notificationEnabled: true, notificationEmail: ` ${MAIL} ` }, null, MAIL],
  ['ungültige Adresse am Eintrag, keine alte Einstellung',
    { notificationEnabled: true, notificationEmail: 'kaputt', userFingerprint: 'f' }, SETTINGS, null],
  ['eingeschaltet ohne Adresse', { notificationEnabled: true, userFingerprint: 'f' }, SETTINGS, null],
  ['alte Nutzereinstellung', { userFingerprint: 'f' }, SETTINGS, SETTINGS.email],
  ['alte Nutzereinstellung bei ausgeschaltetem Eintrag',
    { notificationEnabled: false, notificationEmail: MAIL, userFingerprint: 'f' }, SETTINGS, SETTINGS.email],
  ['alte Einstellung ausgeschaltet', { userFingerprint: 'f' }, { ...SETTINGS, notificationsEnabled: false }, null],
  ['alte Einstellung ohne gültige Adresse', { userFingerprint: 'f' }, { ...SETTINGS, email: 'x' }, null],
  ['keine Einstellung', { userFingerprint: 'f' }, null, null],
  ['kein Fingerabdruck', {}, SETTINGS, null],
  ['Adresse ist keine Zeichenkette', { notificationEnabled: true, notificationEmail: [MAIL] }, null, null],
]) {
  test(`Mail im Altbestand: ${name}`, () => {
    assert.equal(legacyMailAddress(entry, settings), expected);
    assert.equal(legacyMailRecipient(entry, settings), expected !== null);
  });
}

for (const [name, entry, expected] of [
  ['Benachrichtigung am Eintrag', { notificationEnabled: true, notificationEmail: MAIL }, MAIL],
  ['ausgeschaltet', { notificationEnabled: false, notificationEmail: MAIL }, null],
  ['ohne Adresse', { notificationEnabled: true, notificationEmail: null }, null],
  ['ungültige Adresse', { notificationEnabled: true, notificationEmail: 'a@b' }, null],
  ['alte Nutzereinstellung zählt nicht', { userFingerprint: 'f' }, null],
]) {
  test(`Mail im Workspace: ${name}`, () => {
    assert.equal(workspaceMailAddress(entry), expected);
    assert.equal(workspaceMailRecipient(entry), expected !== null);
  });
}

test('feste Meldungen aus dem Plan', () => {
  const texts = Object.values(PUSH_MESSAGES);
  for (const text of [
    'Der öffentliche Eintrag ist nicht freigegeben.',
    'Den öffentlichen Eintrag gibt es nicht mehr.',
    'Die Quelle antwortet nicht.',
    'Status veröffentlicht, die Mail ging nicht raus.',
    'Ob die Mail rausging, ist unklar.',
    'Für Mails zum alten Board fehlt der Absender. Nichts veröffentlicht.',
    'Mailversand ist nicht eingerichtet. Nichts veröffentlicht.',
  ]) assert.ok(texts.includes(text), text);
  assert.ok(texts.every((text) => typeof text === 'string' && text.endsWith('.')));
});
