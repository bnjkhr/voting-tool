'use strict';

// Einzige Quelle für das Ticketnummern-Format.
//
// Die Nummer wird je nach Backend an zwei Stellen erzeugt: im Firestore-Pfad
// (api/index.js, Transaktion über 'counters') und im Postgres-Pfad
// (db/apps.js, atomarer Bump von apps.next_ticket_number). Beide MÜSSEN
// exakt dasselbe Format liefern — sonst driften die Nummern beim Backend-
// Wechsel auseinander und bereits vergebene Tickets sehen anders aus als neue.
//
// Der Präfix-Fallback ist bewusst derselbe wie in
// api/tenant-provisioning.js (buildTicketPrefix): 'APP'. Vorher stand in
// db/apps.js ein abweichendes 'TICKET' — d.h. ein Board ohne ticket_prefix
// hätte unter Postgres 'TICKET-001' statt 'APP-001' bekommen.
const TICKET_NUMBER_PAD = 3;
const DEFAULT_TICKET_PREFIX = 'APP';

function formatTicketNumber(prefix, number) {
  const cleanPrefix = typeof prefix === 'string' ? prefix.trim() : '';
  return `${cleanPrefix || DEFAULT_TICKET_PREFIX}-${String(number).padStart(TICKET_NUMBER_PAD, '0')}`;
}

module.exports = { DEFAULT_TICKET_PREFIX, formatTicketNumber };
