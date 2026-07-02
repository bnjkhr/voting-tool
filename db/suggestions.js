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

// Admin: alle Einträge einer App bzw. eines Tenants.
async function listByApp(appId) {
  const { rows } = await query(
    `select ${COLUMNS} from suggestions where app_id = $1 order by created_at desc`,
    [appId]
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

async function create(data) {
  const {
    id, tenantId, appId, type, title, description = '', status = 'neu',
    priority = null, labels = [], tag = null, votes = 0, approved = false,
    releaseId = null, ticketNumber = null, userFingerprint = null,
    notificationEnabled = false, notificationEmail = null,
    severity = null, stepsToReproduce = null, expectedBehavior = null,
    actualBehavior = null, environment = null,
  } = data;

  const { rows } = await query(
    `insert into suggestions (
       id, tenant_id, app_id, type, title, description, status, priority, labels,
       tag, votes, approved, release_id, ticket_number, user_fingerprint,
       notification_enabled, notification_email, severity, steps_to_reproduce,
       expected_behavior, actual_behavior, environment
     ) values (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
     ) returning ${COLUMNS}`,
    [
      id, tenantId, appId, type, title, description, status, priority, labels,
      tag, votes, approved, releaseId, ticketNumber, userFingerprint,
      notificationEnabled, notificationEmail, severity, stepsToReproduce,
      expectedBehavior, actualBehavior, environment ? JSON.stringify(environment) : null,
    ]
  );
  return mapRow(rows[0]);
}

// Partielles Update für skalare Felder (status, priority, tag, tagUpdatedAt,
// approved, approvedAt, releaseId, title, description, notificationEmail …).
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
  findById, listPublicForApp, listByApp, listByTenant, listByRelease,
  listApprovedByReleaseIds, countByReleaseIds, create, update, setApproved, addLabel, removeLabel, remove,
};
