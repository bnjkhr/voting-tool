'use strict';

// Repository für activity (Ticket-Verlauf/Audit-Log). Ersetzt die frühere
// Firestore-Collection; Rückgabe im bisherigen camelCase-Shape (mapRow).
const { query } = require('./pool');
const { mapRow, mapRows } = require('./rows');

const COLUMNS = `
  id, tenant_id, ticket_id, action, old_value, new_value, detail, actor, created_at
`;

async function log({ tenantId, ticketId, action, oldValue = null, newValue = null, detail = null, actor = null }) {
  const { rows } = await query(
    `insert into activity (tenant_id, ticket_id, action, old_value, new_value, detail, actor)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${COLUMNS}`,
    [tenantId, ticketId, action, oldValue, newValue, detail, actor]
  );
  return mapRow(rows[0]);
}

async function listByTicket(ticketId) {
  const { rows } = await query(
    `select ${COLUMNS} from activity where ticket_id = $1 order by created_at asc`,
    [ticketId]
  );
  return mapRows(rows);
}

module.exports = { log, listByTicket };
