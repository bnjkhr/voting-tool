'use strict';

// Reine Logik fürs Holen öffentlicher Einträge in private Workspaces: welcher
// Eintrag geholt wird, was davon ins Ticket kommt und was sich an bestehenden
// Verknüpfungen geändert hat. Kein Netz, keine Datenbank.
const { buildUrlState } = require('../public/url-state');

const FEEDBACK_LABEL = 'Feedback';
// Präfix `api:`: Das Ticket hat keine Mailadresse, ein Statuswechsel braucht
// keine Rückfrage (BoardModel.needsConfirm).
const FEEDBACK_FINGERPRINT = 'api:feedback';
const TITLE_LIMIT = 100;
const DESCRIPTION_LIMIT = 1000;
const TRUNCATION_NOTE = '\n\n[Gekürzt. Der ganze Text steht im öffentlichen Eintrag.]';
const LEGACY_BOARD_BASE = 'https://votingtool.benkohler.de';

const PRIORITIES = ['niedrig', 'mittel', 'hoch', 'kritisch'];

// Öffentlicher Status -> Status des neuen Tickets; alles andere startet als `neu`.
const START_STATUSES = new Map([
  ['neu', 'neu'],
  ['offen', 'neu'],
  ['wird geprüft', 'neu'],
  ['in Bearbeitung', 'in Bearbeitung'],
  ['wird umgesetzt', 'in Bearbeitung'],
  ['im Test', 'im Test'],
  ['wartend', 'wartend'],
]);

function startStatusFor(publicStatus) {
  return START_STATUSES.get(publicStatus) || 'neu';
}

// Ungeprüfte Einträge kann jeder ohne Anmeldung anlegen: Nur ein ausdrückliches
// `true` zählt als freigegeben.
function isFetchable(entry, resolvedStatuses) {
  return entry.approved === true && !resolvedStatuses.includes(entry.status);
}

// Text von außen: nur Zeichenketten, ohne Nullzeichen (die lehnt Postgres ab).
function cleanText(value) {
  return typeof value === 'string' ? value.replaceAll('\u0000', '').trim() : '';
}

// Kürzt, ohne ein Zeichen aus zwei Code-Einheiten zu zerteilen.
function cut(text, limit) {
  const part = text.slice(0, limit);
  return /[\uD800-\uDBFF]$/.test(part) ? part.slice(0, -1) : part;
}

// Aus dem Eintrag kommen nur Titel, Beschreibung und Priorität. Alles zur
// einreichenden Person (Mail, Kennung, Bilder, Umgebung) bleibt, wo es ist.
function buildTicketFromEntry(entry) {
  const description = cleanText(entry.description);
  return {
    type: 'ticket',
    title: cut(cleanText(entry.title), TITLE_LIMIT) || 'Ohne Titel',
    description: description.length > DESCRIPTION_LIMIT
      ? cut(description, DESCRIPTION_LIMIT) + TRUNCATION_NOTE
      : description,
    priority: PRIORITIES.includes(entry.priority) ? entry.priority : null,
    status: startStatusFor(entry.status),
    labels: [FEEDBACK_LABEL],
    approved: true,
    userFingerprint: FEEDBACK_FINGERPRINT,
    notificationEnabled: false,
    notificationEmail: null,
  };
}

// Vergleicht die Einträge einer Quelle mit den vorhandenen Verknüpfungen. Auch
// ein Grabstein (Verknüpfung ohne Ticket) sperrt das erneute Anlegen.
function planFetch({ entries, links, resolvedStatuses }) {
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const linkedIds = new Set(links.map((link) => link.entryId));
  const refresh = [];
  const missing = [];

  for (const link of links) {
    const entry = entriesById.get(link.entryId);
    if (!entry) {
      missing.push(link.id);
      continue;
    }
    refresh.push({
      linkId: link.id,
      publicStatus: entry.status ?? null,
      publicType: entry.type ?? null,
      publicApproved: entry.approved === true,
      publicDeleted: false,
    });
  }

  return {
    toCreate: entries.filter((entry) => !linkedIds.has(entry.id) && isFetchable(entry, resolvedStatuses)),
    refresh,
    missing,
    unapprovedCount: entries.filter((entry) => entry.approved !== true).length,
  };
}

// Der Altbestand hat keine Links je Eintrag: Ziel ist sein Board.
function legacyBoardUrl(sourceAppId) {
  return `${LEGACY_BOARD_BASE}${buildUrlState({ appId: sourceAppId })}`;
}

module.exports = {
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
};
