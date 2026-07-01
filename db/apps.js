'use strict';

// Repository für apps (Boards). Enthält den Ticketnummer-Bump, der die frühere
// Firestore-Transaktion + eigene 'counters'-Collection ersetzt.
const { query } = require('./pool');
const { mapRow, mapRows, buildUpdate } = require('./rows');

const COLUMNS = `
  id, tenant_id, name, description, slug, ticket_prefix, labels,
  next_ticket_number, created_at, updated_at
`;

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from apps where id = $1`, [id]);
  return mapRow(rows[0]);
}

async function findBySlug(tenantId, slug) {
  const { rows } = await query(
    `select ${COLUMNS} from apps where tenant_id = $1 and slug = $2`,
    [tenantId, slug]
  );
  return mapRow(rows[0]);
}

async function listByTenant(tenantId) {
  const { rows } = await query(
    `select ${COLUMNS} from apps where tenant_id = $1 order by name asc`,
    [tenantId]
  );
  return mapRows(rows);
}

async function create({ id, tenantId, name, description = '', slug, ticketPrefix = null, labels = [] }) {
  const { rows } = await query(
    `insert into apps (id, tenant_id, name, description, slug, ticket_prefix, labels)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${COLUMNS}`,
    [id, tenantId, name, description, slug, ticketPrefix, labels]
  );
  return mapRow(rows[0]);
}

async function update(id, fields) {
  const { setClause, values, nextIndex } = buildUpdate(fields);
  if (!setClause) return findById(id);
  const { rows } = await query(
    `update apps set ${setClause}, updated_at = now()
     where id = $${nextIndex} returning ${COLUMNS}`,
    [...values, id]
  );
  return mapRow(rows[0]);
}

async function remove(id) {
  // ON DELETE CASCADE räumt suggestions/votes/comments/releases mit ab.
  await query('delete from apps where id = $1', [id]);
}

// Atomarer Ticketnummer-Bump: liefert die auszugebende Nummer und erhöht den
// Zähler in einem Schritt. Ersetzt collection 'counters' + runTransaction.
async function nextTicketNumber(appId) {
  const { rows } = await query(
    `update apps set next_ticket_number = next_ticket_number + 1
     where id = $1 returning next_ticket_number - 1 as issued, ticket_prefix`,
    [appId]
  );
  if (!rows[0]) throw new Error(`App ${appId} nicht gefunden`);
  const { issued, ticket_prefix: prefix } = rows[0];
  return { number: issued, prefix, ticketNumber: `${prefix || 'TICKET'}-${String(issued).padStart(3, '0')}` };
}

module.exports = {
  findById, findBySlug, listByTenant, create, update, remove, nextTicketNumber,
};
