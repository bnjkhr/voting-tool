'use strict';

// Import-Modus für POST /api/v1/apps/:appSlug/suggestions.
//
// Beim Übertragen eines gewachsenen Boards gehen sonst genau die Felder
// verloren, die der Server selbst vergibt: Ticketnummer und Einreichungsdatum.
// Dieses Modul validiert den `import`-Block und rechnet die Zählerfortschreibung
// aus. Bewusst frei von Firestore/Postgres, damit die kritische Arithmetik
// (Import FAM-140 → nächste generierte Nummer FAM-141) direkt testbar ist.

// Ticketnummern des Generators: <PREFIX>-<Zahl>, Prefix max. 5 Zeichen
// (buildTicketPrefix), Zahl mindestens dreistellig gepolstert.
const TICKET_NUMBER_PATTERN = /^([A-Za-z]{1,5})-(\d{1,6})$/;

const MAX_IMPORT_VOTES = 1000000;

function parseImportTicketNumber(value, expectedPrefix) {
  if (typeof value !== 'string' || !value.trim()) {
    return { error: 'import.ticketNumber muss ein String im Format PREFIX-123 sein' };
  }

  const ticketNumber = value.trim();
  const match = TICKET_NUMBER_PATTERN.exec(ticketNumber);
  if (!match) {
    return { error: `Ungültige Ticketnummer "${ticketNumber}". Erwartet: PREFIX-123` };
  }

  const [, prefix, digits] = match;
  const number = Number.parseInt(digits, 10);
  if (!Number.isSafeInteger(number) || number < 1) {
    return { error: `Ungültige Ticketnummer "${ticketNumber}". Die laufende Nummer muss ≥ 1 sein` };
  }

  // Der Zähler eines Boards kennt genau ein Prefix. Eine fremde Nummer würde
  // still an der Fortschreibung vorbeilaufen und später doch kollidieren —
  // deshalb hier hart abweisen statt heimlich zu akzeptieren.
  const boardPrefix = typeof expectedPrefix === 'string' ? expectedPrefix.trim() : '';
  if (boardPrefix && prefix.toUpperCase() !== boardPrefix.toUpperCase()) {
    return {
      error: `Ticketnummer "${ticketNumber}" passt nicht zum Board-Prefix "${boardPrefix}"`,
    };
  }

  return { ticketNumber, prefix, number };
}

// Ausgabeformat der Ticketnummern. Lebt hier neben nextCounterValue, damit die
// Runde "Import hebt den Zähler an → Generator gibt die nächste Nummer aus" in
// einem Test aus echten Produktionsfunktionen zusammengesetzt werden kann.
function formatTicketNumber(prefix, number) {
  return `${prefix}-${String(number).padStart(3, '0')}`;
}

// Der Zähler zeigt immer auf die NÄCHSTE auszugebende Nummer. Nach einem Import
// von …-140 muss er also mindestens auf 141 stehen; ein bereits höherer Stand
// wird nie zurückgedreht.
function nextCounterValue(currentNext, importedNumber) {
  const current = Number.isFinite(Number(currentNext)) ? Number(currentNext) : 1;
  return Math.max(current || 1, importedNumber + 1);
}

// Nimmt den kompletten Request-Body, damit auch die Regeln hier leben, die vom
// Zusammenspiel von `import` mit anderen Feldern abhängen.
function parseImportBlock(body = {}, { ticketPrefix } = {}, now = new Date()) {
  const input = body?.import;
  if (input === undefined || input === null) return { importData: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'import muss ein Objekt sein' };
  }

  // Notification-Adressen sind bewusst nicht importierbar: ein späterer
  // Statuswechsel würde sonst Mails an Leute schicken, die von dem neuen Board
  // nichts wissen. Lieber laut ablehnen als still verwerfen.
  if (body.notificationEnabled) {
    return {
      error: 'Notification-Adressen können nicht importiert werden (notificationEnabled muss beim Import false sein)',
    };
  }

  const importData = {};

  if (input.ticketNumber !== undefined) {
    const parsed = parseImportTicketNumber(input.ticketNumber, ticketPrefix);
    if (parsed.error) return { error: parsed.error };
    importData.ticketNumber = parsed.ticketNumber;
    importData.ticketNumberValue = parsed.number;
  }

  if (input.votes !== undefined) {
    // Bewusst strikt: "2" statt 2 ist ein Aufrufer-Bug, keine Stimme.
    const votes = input.votes;
    if (typeof votes !== 'number' || !Number.isInteger(votes) || votes < 0 || votes > MAX_IMPORT_VOTES) {
      return { error: `import.votes muss eine ganze Zahl zwischen 0 und ${MAX_IMPORT_VOTES} sein` };
    }
    importData.votes = votes;
  }

  if (input.createdAt !== undefined) {
    const createdAt = new Date(input.createdAt);
    if (Number.isNaN(createdAt.getTime())) {
      return { error: 'import.createdAt muss ein gültiges Datum (ISO 8601) sein' };
    }
    if (createdAt.getTime() > now.getTime()) {
      return { error: 'import.createdAt muss in der Vergangenheit liegen' };
    }
    importData.createdAt = createdAt;
  }

  if (Object.keys(importData).length === 0) {
    return { error: 'import braucht mindestens eines der Felder: ticketNumber, votes, createdAt' };
  }

  return { importData };
}

module.exports = {
  MAX_IMPORT_VOTES,
  formatTicketNumber,
  nextCounterValue,
  parseImportBlock,
  parseImportTicketNumber,
};
