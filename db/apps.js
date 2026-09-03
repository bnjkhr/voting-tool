'use strict';

// Repository für apps (Boards). Enthält den Ticketnummer-Bump, der die frühere
// Firestore-Transaktion + eigene 'counters'-Collection ersetzt.
const { query, withTransaction } = require('./pool');
const { mapRow, mapRows, buildUpdate } = require('./rows');
const { formatTicketNumber } = require('../lib/ticket-number');

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

// Loescht ein Board samt allem, was daran haengt, und liefert die Anzahlen.
//
// ON DELETE CASCADE deckt releases und suggestions ab, ueber suggestions auch
// comments und votes. NICHT abgedeckt: `attachments` (polymorph ueber
// parent_type/parent_id, kein FK auf suggestions — dort liegen die Screenshot-
// Bytes) und `activity` (gar kein FK). Beide muessen explizit weg, und zwar
// BEVOR die Cascade ihre Eltern entfernt — danach sind sie nicht mehr
// auffindbar. Gleiches Muster wie suggestions.remove().
async function remove(id, tenantId) {
  return withTransaction(async (client) => {
    // 0. Tenant-Grenze ZUERST. withTransaction committet bei normalem Return —
    //    ein spaeteres `return null` wuerde die Loeschungen darunter also nicht
    //    zurueckrollen. Stuende die Pruefung erst beim finalen Delete, haette
    //    remove(id, 'fremder-tenant') die Attachments und die Activity dieses
    //    Boards bereits vernichtet und dabei "nicht gefunden" gemeldet.
    //    `for update` haelt die Zeile bis zum Commit.
    const owned = await client.query(
      'select 1 from apps where id = $1 and tenant_id = $2 for update',
      [id, tenantId]
    );
    if (owned.rowCount === 0) return null;

    // 1. Attachments beider parent_type-Zweige, solange die Comments noch da sind.
    const attachments = await client.query(
      `delete from attachments
       where (parent_type = 'suggestion'
              and parent_id in (select id from suggestions where app_id = $1))
          or (parent_type = 'comment'
              and parent_id in (select c.id from comments c
                                join suggestions s on s.id = c.suggestion_id
                                where s.app_id = $1))`,
      [id]
    );

    // 2. activity haengt nur ueber ticket_id an den suggestions.
    const activity = await client.query(
      'delete from activity where ticket_id in (select id from suggestions where app_id = $1)',
      [id]
    );

    // 3. Zaehlen, solange es noch etwas zu zaehlen gibt — die Cascade meldet
    //    keine Zeilenzahlen zurueck.
    const { rows } = await client.query(
      `select
         (select count(*) from suggestions where app_id = $1)::int as suggestions,
         (select count(*) from comments c join suggestions s on s.id = c.suggestion_id
            where s.app_id = $1)::int as comments,
         (select count(*) from votes v join suggestions s on s.id = v.suggestion_id
            where s.app_id = $1)::int as votes,
         (select count(*) from releases where app_id = $1)::int as releases`,
      [id]
    );

    // 4. Das Board selbst. Bleibt zusaetzlich tenant-gescopt.
    await client.query('delete from apps where id = $1 and tenant_id = $2', [id, tenantId]);

    return {
      ...rows[0],
      activity: activity.rowCount,
      attachments: attachments.rowCount,
    };
  });
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
  return { number: issued, prefix, ticketNumber: formatTicketNumber(prefix, issued) };
}

module.exports = {
  findById, findBySlug, listByTenant, create, update, remove, nextTicketNumber,
};
