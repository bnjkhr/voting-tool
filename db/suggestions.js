'use strict';

// Repository für suggestions (Feature/Bug/Ticket) — die zentrale Entität.
const { query, withTransaction } = require('./pool');
const { mapRow, mapRows, buildUpdate } = require('./rows');

const COLUMNS = `
  id, tenant_id, app_id, type, title, description, status, priority, labels,
  tag, tag_updated_at, votes, approved, approved_at, release_id, ticket_number,
  user_fingerprint, notification_enabled, notification_email,
  severity, steps_to_reproduce, expected_behavior, actual_behavior,
  environment, created_at
`;

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from suggestions where id = $1`, [id]);
  return mapRow(rows[0]);
}

// Öffentliches Board: nur freigegebene Einträge, meiste Stimmen zuerst.
async function listPublicForApp(appId) {
  const { rows } = await query(
    `select ${COLUMNS} from suggestions
     where app_id = $1 and approved = true
     order by votes desc, created_at desc`,
    [appId]
  );
  return mapRows(rows);
}

// Admin: alle Einträge eines Tenants.
// Alle Einträge einer App — tenant-gescopt und mit den Filtern der v1-API
// direkt in der WHERE-Klausel. Sonst wandert das ganze Board über die Leitung, nur um in
// JS weggeworfen zu werden. type/status sind NOT NULL mit CHECK-Constraint,
// deshalb ist ein Gleichheitsvergleich hier äquivalent zur JS-Filterung.
async function listByAppFiltered(appId, tenantId, { type, status, approved } = {}) {
  const conditions = ['app_id = $1', 'tenant_id = $2'];
  const values = [appId, tenantId];
  for (const [column, value] of [['type', type], ['status', status], ['approved', approved]]) {
    if (value === undefined || value === null || value === '') continue;
    values.push(value);
    conditions.push(`${column} = $${values.length}`);
  }
  const { rows } = await query(
    `select ${COLUMNS} from suggestions
     where ${conditions.join(' and ')}
     order by created_at desc`,
    values
  );
  return mapRows(rows);
}

async function listByTenant(tenantId) {
  const { rows } = await query(
    `select ${COLUMNS} from suggestions where tenant_id = $1 order by created_at desc`,
    [tenantId]
  );
  return mapRows(rows);
}

async function listByRelease(releaseId) {
  const { rows } = await query(
    `select ${COLUMNS} from suggestions where release_id = $1 order by created_at desc`,
    [releaseId]
  );
  return mapRows(rows);
}

// Approved Suggestions für mehrere Releases (tenant-gescopt) — für den
// öffentlichen Roadmap/Changelog-View. Ersetzt den gechunkten releaseId-in-Scan.
// Anzahl Suggestions je Release (alle, tenant-gescopt) als Map — für die
// Admin-Roadmap-Ansicht (itemCount). Ersetzt den gechunkten releaseId-in-Scan.
async function countByReleaseIds(releaseIds, tenantId) {
  const map = {};
  if (!releaseIds || releaseIds.length === 0) return map;
  const { rows } = await query(
    `select release_id, count(*)::int as n from suggestions
     where release_id = any($1::text[]) and tenant_id = $2
     group by release_id`,
    [releaseIds, tenantId]
  );
  for (const r of rows) map[r.release_id] = r.n;
  return map;
}

async function listApprovedByReleaseIds(releaseIds, tenantId) {
  if (!releaseIds || releaseIds.length === 0) return [];
  const { rows } = await query(
    `select ${COLUMNS} from suggestions
     where release_id = any($1::text[]) and tenant_id = $2 and approved = true
     order by created_at desc`,
    [releaseIds, tenantId]
  );
  return mapRows(rows);
}

// Default für direkt freigegebene Creates (z.B. via API-Key): fehlt der
// Zeitstempel, wird er hier gesetzt — `approved = true` ohne Datum wäre eine
// halbfertige Zeile. Spiegelt db/comments.js create(). Kein harter Invariant:
// update() und der Firestore-Import können approved ohne Datum schreiben;
// das müsste eine CHECK-Constraint erzwingen.
function resolveApprovedAt(approved, approvedAt) {
  if (!approved) return null;
  return approvedAt || new Date();
}

// Insert-Kern, damit create() und der Import-Pfad exakt dieselben Spalten und
// Defaults schreiben. `exec` ist der Pool (query) oder ein Transaktions-Client.
async function insertSuggestion(exec, data) {
  const {
    id, tenantId, appId, type, title, description = '', status = 'neu',
    priority = null, labels = [], tag = null, votes = 0, approved = false,
    approvedAt = null, createdAt = null,
    releaseId = null, ticketNumber = null, userFingerprint = null,
    notificationEnabled = false, notificationEmail = null,
    severity = null, stepsToReproduce = null, expectedBehavior = null,
    actualBehavior = null, environment = null,
  } = data;

  // created_at ist nur beim Import gesetzt (historisches Einreichungsdatum);
  // sonst uebernimmt der Spalten-Default now().
  const { rows } = await exec(
    `insert into suggestions (
       id, tenant_id, app_id, type, title, description, status, priority, labels,
       tag, votes, approved, approved_at, release_id, ticket_number, user_fingerprint,
       notification_enabled, notification_email, severity, steps_to_reproduce,
       expected_behavior, actual_behavior, environment, created_at
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
       coalesce($24, now())
     ) returning ${COLUMNS}`,
    [
      id, tenantId, appId, type, title, description, status, priority, labels,
      tag, votes, approved, resolveApprovedAt(approved, approvedAt), releaseId, ticketNumber, userFingerprint,
      notificationEnabled, notificationEmail, severity, stepsToReproduce,
      expectedBehavior, actualBehavior, environment ? JSON.stringify(environment) : null,
      createdAt,
    ]
  );
  return mapRow(rows[0]);
}

async function create(data) {
  return insertSuggestion(query, data);
}

// Import mit mitgebrachter Ticketnummer. Eindeutigkeitspruefung, Fortschreibung
// des Board-Zaehlers und Insert laufen in EINER Transaktion — sonst kann die
// importierte Nummer spaeter vom Generator erneut vergeben werden, oder zwei
// parallele Importe legen dieselbe Nummer doppelt an.
//
// Beruehrt bewusst auch apps.next_ticket_number: die Nummer und der Zaehler
// sind eine gemeinsame Invariante, kein reiner suggestions-Belang.
// Verletzung des Unique-Index aus migration 0007. Der vorgelagerte SELECT faengt
// den Normalfall ab und liefert die schoene Fehlermeldung; hier landet nur das
// Rennen zweier gleichzeitiger Importe derselben Nummer.
const TICKET_NUMBER_UNIQUE_INDEX = 'suggestions_app_ticket_number_uidx';

function isTicketNumberConflict(error) {
  return Boolean(error) && error.code === '23505' && error.constraint === TICKET_NUMBER_UNIQUE_INDEX;
}

async function createWithImportedTicketNumber({ appId, tenantId, ticketNumber, ticketNumberValue, data }) {
  try {
    return await insertWithImportedTicketNumber({ appId, tenantId, ticketNumber, ticketNumberValue, data });
  } catch (error) {
    // Der SELECT unten ist ein Check-then-Insert: unter READ COMMITTED sieht er
    // eine noch nicht committete Parallel-Einfuegung nicht. Den Gleichstand
    // entscheidet deshalb der Unique-Index, und der Verlierer bekommt denselben
    // 409 wie beim regulaer erkannten Duplikat — nicht ein 500.
    if (isTicketNumberConflict(error)) return { conflict: true };
    throw error;
  }
}

async function insertWithImportedTicketNumber({ appId, tenantId, ticketNumber, ticketNumberValue, data }) {
  return withTransaction(async (client) => {
    const exec = (text, params) => client.query(text, params);

    const duplicate = await exec(
      `select 1 from suggestions
       where app_id = $1 and tenant_id = $2 and ticket_number = $3
       limit 1`,
      [appId, tenantId, ticketNumber]
    );
    if (duplicate.rows.length > 0) return { conflict: true };

    // greatest() dreht einen bereits hoeheren Stand nie zurueck.
    await exec(
      `update apps set next_ticket_number = greatest(next_ticket_number, $2)
       where id = $1 and tenant_id = $3`,
      [appId, ticketNumberValue + 1, tenantId]
    );

    return { row: await insertSuggestion(exec, { ...data, ticketNumber }) };
  });
}

async function update(id, fields) {
  const { setClause, values, nextIndex } = buildUpdate(fields);
  if (!setClause) return findById(id);
  const { rows } = await query(
    `update suggestions set ${setClause} where id = $${nextIndex} returning ${COLUMNS}`,
    [...values, id]
  );
  return mapRow(rows[0]);
}

async function setApproved(id) {
  return update(id, { approved: true, approvedAt: new Date() });
}

// Label-Operationen (ersetzen Firestore arrayUnion/arrayRemove) — dedupliziert.
async function addLabel(id, label) {
  const { rows } = await query(
    `update suggestions
     set labels = case when $2 = any(labels) then labels else array_append(labels, $2) end
     where id = $1 returning ${COLUMNS}`,
    [id, label]
  );
  return mapRow(rows[0]);
}

async function removeLabel(id, label) {
  const { rows } = await query(
    `update suggestions set labels = array_remove(labels, $2)
     where id = $1 returning ${COLUMNS}`,
    [id, label]
  );
  return mapRow(rows[0]);
}

// Löscht Suggestion inkl. abhängiger activity-Zeilen. votes/comments räumt der
// FK ON DELETE CASCADE ab; activity und attachments haben keinen FK (soft/poly
// ref) -> explizit. Attachments der Suggestion UND ihrer Comments zuerst löschen,
// solange die Comments-Zeilen noch existieren.
async function remove(id) {
  await withTransaction(async (client) => {
    await client.query(
      `delete from attachments
       where (parent_type = 'suggestion' and parent_id = $1)
          or (parent_type = 'comment' and parent_id in (select id from comments where suggestion_id = $1))`,
      [id]
    );
    await client.query('delete from activity where ticket_id = $1', [id]);
    await client.query('delete from suggestions where id = $1', [id]);
  });
}

module.exports = {
  findById, listPublicForApp, listByAppFiltered, listByTenant, listByRelease,
  listApprovedByReleaseIds, countByReleaseIds, create, createWithImportedTicketNumber,
  isTicketNumberConflict, update, setApproved, addLabel, removeLabel, remove,
};
