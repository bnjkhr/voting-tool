'use strict';

// Reine Entscheidungen fürs Zurückschreiben des Status in den öffentlichen
// Eintrag: Zielstatus, Rückschritt, ob eine Mail ginge. Kein Netz, keine
// Datenbank.

const TEST_STATUS = 'im Test';

// Interner Status -> öffentlicher Status für Tickets und Bugs bzw. Features.
// Was hier fehlt, ändert öffentlich nichts; „im Test“ gibt es nur auf Wunsch.
const TARGETS = new Map([
  ['in Bearbeitung', { ticket: 'in Bearbeitung', feature: 'wird umgesetzt' }],
  ['wird umgesetzt', { ticket: 'in Bearbeitung', feature: 'wird umgesetzt' }],
  ['gelöst', { ticket: 'gelöst', feature: 'ist umgesetzt' }],
  ['ist umgesetzt', { ticket: 'gelöst', feature: 'ist umgesetzt' }],
]);

const DONE_RANK = 3;

// Wie weit ein öffentlicher Status ist.
const TICKET_RANKS = new Map([
  ['neu', 0], ['offen', 0], ['in Bearbeitung', 1], ['wartend', 1], [TEST_STATUS, 2],
  ['gelöst', DONE_RANK], ['geschlossen', DONE_RANK],
]);
const FEATURE_RANKS = new Map([
  ['neu', 0], ['wird geprüft', 0], ['wird umgesetzt', 1], [TEST_STATUS, 2],
  ['ist umgesetzt', DONE_RANK], ['wird nicht umgesetzt', DONE_RANK],
]);

// Alles, was über das Zurückschreiben in Antworten, in Postgres und ins Log darf.
const PUSH_MESSAGES = Object.freeze({
  notApproved: 'Der öffentliche Eintrag ist nicht freigegeben.',
  gone: 'Den öffentlichen Eintrag gibt es nicht mehr.',
  timeout: 'Die Quelle antwortet nicht.',
  boardUnavailable: 'Das öffentliche Board ist nicht erreichbar.',
  sourceInactive: 'Der Quell-Workspace ist nicht öffentlich erreichbar.',
  failed: 'Das Veröffentlichen ist fehlgeschlagen.',
  mailFailed: 'Status veröffentlicht, die Mail ging nicht raus.',
  mailUnclear: 'Ob die Mail rausging, ist unklar.',
  noLegacySender: 'Für Mails zum alten Board fehlt der Absender. Nichts veröffentlicht.',
  noMailSetup: 'Mailversand ist nicht eingerichtet. Nichts veröffentlicht.',
  mailNeedsClick: 'Zu diesem Eintrag ginge eine Mail raus. Nichts veröffentlicht.',
  changed: 'Die wartende Änderung hat sich geändert. Nichts veröffentlicht.',
  busy: 'Die Änderung wird gerade veröffentlicht.',
  nothingPending: 'Hier wartet keine Änderung mehr.',
  alreadyPublic: 'Der öffentliche Status stand schon so. Es ging keine Mail raus.',
  pushOff: 'Zurückschreiben ist für dieses Board ausgeschaltet.',
  notLinked: 'Dieses Ticket ist nicht verknüpft.',
  notInTest: 'Das Ticket steht intern nicht auf „im Test“.',
  ownerOnly: 'Veröffentlichen kann nur ein angemeldeter Owner.',
  waitingMail: 'Öffentlich noch nicht geändert: Es ginge eine Mail raus. Die Änderung wartet auf der Karte.',
  waitingBackward: 'Öffentlich noch nicht geändert: Das wäre ein Rückschritt. Die Änderung wartet auf der Karte.',
  waitingBusy: 'Öffentlich noch nicht geändert: Gerade läuft schon eine Veröffentlichung.',
});

// `explicitTest`: Jemand will ausdrücklich „im Test“ veröffentlichen.
function targetFor(internalStatus, publicType, { explicitTest = false } = {}) {
  if (internalStatus === TEST_STATUS) return explicitTest ? TEST_STATUS : null;
  const target = TARGETS.get(internalStatus);
  if (!target) return null;
  return publicType === 'feature' ? target.feature : target.ticket;
}

// Rückschritt: öffentlich schon weiter, oder schon erledigt und nun anders. Ein
// unbekannter öffentlicher Status zählt als Rückschritt, dann entscheidet Ben.
function isBackward(current, target, publicType) {
  if (current === target) return false;
  const ranks = publicType === 'feature' ? FEATURE_RANKS : TICKET_RANKS;
  const from = ranks.get(current);
  if (from === undefined || from === DONE_RANK) return true;
  return ranks.get(target) < from;
}

// Was mit dem öffentlichen Eintrag geschehen soll:
//   clear  der interne Status ändert öffentlich nichts
//   none   der Eintrag steht schon so
//   wait   erst auf Klick (Mail oder Rückschritt)
//   write  sofort
function decidePush({ internalStatus, entry, mail, explicitTest = false }) {
  const target = targetFor(internalStatus, entry.type, { explicitTest });
  if (!target) return { action: 'clear', target: null };
  if (entry.status === target) return { action: 'none', target };
  if (mail) return { action: 'wait', target, reason: 'mail' };
  if (isBackward(entry.rankStatus ?? entry.status, target, entry.type)) {
    return { action: 'wait', target, reason: 'backward' };
  }
  return { action: 'write', target };
}

// Sehr alte Einträge haben nur ein Kennzeichen. Es ist gröber als der Status:
// „in analyse“ kann auch „im Test“ sein, und „im Test“ an einem Feature kennt
// die Rückübersetzung nicht. Für den Rückschritt zählt der höhere Rang.
function legacyStatus(data, type, mappedStatus) {
  if (data.status) return { status: data.status, rankStatus: data.status };
  const tag = String(data.tag || '').trim().toLowerCase();
  if (type === 'feature' && tag === TEST_STATUS.toLowerCase()) {
    return { status: TEST_STATUS, rankStatus: TEST_STATUS };
  }
  const maybeTesting = type !== 'feature' && tag === 'in analyse';
  return { status: mappedStatus, rankStatus: maybeTesting ? TEST_STATUS : mappedStatus };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Die Adresse bleibt im Arbeitsspeicher: nie speichern, antworten oder loggen.
function validAddress(value) {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  return EMAIL.test(address) ? address : null;
}

// Alte Einträge ohne eigene Benachrichtigung fallen auf die Nutzereinstellung
// zum Fingerabdruck zurück.
function needsUserSettings(entry) {
  return !entry.notificationEnabled && Boolean(entry.userFingerprint);
}

// Wie notifySuggestionCreator im Altbestand.
function legacyMailAddress(entry, userSettings) {
  if (entry.notificationEnabled) return validAddress(entry.notificationEmail);
  if (!needsUserSettings(entry) || !userSettings?.notificationsEnabled) return null;
  return validAddress(userSettings.email);
}

function workspaceMailAddress(entry) {
  return entry.notificationEnabled ? validAddress(entry.notificationEmail) : null;
}

const legacyMailRecipient = (entry, userSettings) => legacyMailAddress(entry, userSettings) !== null;
const workspaceMailRecipient = (entry) => workspaceMailAddress(entry) !== null;

module.exports = {
  TEST_STATUS,
  PUSH_MESSAGES,
  targetFor,
  isBackward,
  decidePush,
  legacyStatus,
  needsUserSettings,
  legacyMailAddress,
  legacyMailRecipient,
  workspaceMailAddress,
  workspaceMailRecipient,
};
