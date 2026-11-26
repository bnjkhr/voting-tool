'use strict';

// Eingaben für das Anlegen eines privaten Workspaces
// (scripts/create-private-workspace.js).
const { buildAppSlug } = require('../api/tenant-utils');

const TICKET_PREFIX = /^[A-Z]{1,5}$/;

// "Name:Präfix,Name:Präfix" -> [{ name, slug, ticketPrefix }]. Ein Präfix, das
// die App kürzen oder säubern würde, wird abgewiesen statt still geändert.
function parseBoards(text) {
  const entries = String(text || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('Mindestens ein Board angeben: "Name:Präfix".');

  const boards = entries.map((entry) => {
    const separator = entry.lastIndexOf(':');
    const name = entry.slice(0, Math.max(separator, 0)).trim();
    const prefix = entry.slice(separator + 1).trim().toUpperCase();
    if (separator < 0 || !/[a-z0-9]/i.test(name) || !prefix) {
      throw new Error(`Board "${entry}": erwartet wird Name:Präfix.`);
    }
    if (!TICKET_PREFIX.test(prefix)) {
      throw new Error(`Board "${entry}": Das Präfix besteht aus 1 bis 5 Buchstaben (A bis Z).`);
    }
    return { name, slug: buildAppSlug(name), ticketPrefix: prefix };
  });

  for (const [field, label] of [['slug', 'Der Board-Slug'], ['ticketPrefix', 'Das Präfix']]) {
    const values = boards.map((board) => board[field]);
    const duplicate = values.find((value, index) => values.indexOf(value) !== index);
    if (duplicate) throw new Error(`${label} "${duplicate}" kommt doppelt vor.`);
  }

  return boards;
}

module.exports = { parseBoards };
