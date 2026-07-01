'use strict';

// Repository für comments inkl. Moderations-Flow (pending/approved/rejected).
const { query } = require('./pool');
const { mapRow, mapRows, buildUpdate } = require('./rows');

const COLUMNS = `
  id, tenant_id, suggestion_id, text, author_type, author_fingerprint,
  approval_status, approved_at, approved_by, rejected_at, rejected_by, created_at
`;

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from comments where id = $1`, [id]);
  return mapRow(rows[0]);
}

// Öffentlich: nur freigegebene Kommentare.
async function listApprovedForSuggestion(suggestionId) {
  const { rows } = await query(
    `select ${COLUMNS} from comments
     where suggestion_id = $1 and approval_status = 'approved'
     order by created_at asc`,
    [suggestionId]
  );
  return mapRows(rows);
}

// Admin: alle Kommentare eines Eintrags.
async function listForSuggestion(suggestionId) {
  const { rows } = await query(
    `select ${COLUMNS} from comments where suggestion_id = $1 order by created_at asc`,
    [suggestionId]
  );
  return mapRows(rows);
}

// Moderations-Queue: offene Kommentare eines Tenants.
async function listPendingByTenant(tenantId) {
  const { rows } = await query(
    `select ${COLUMNS} from comments
     where tenant_id = $1 and approval_status = 'pending'
     order by created_at asc`,
    [tenantId]
  );
  return mapRows(rows);
}

async function create(data) {
  const {
    id, tenantId, suggestionId, text, authorType,
    authorFingerprint = null, approvalStatus = 'pending',
  } = data;
  const { rows } = await query(
    `insert into comments (
       id, tenant_id, suggestion_id, text, author_type, author_fingerprint, approval_status
     ) values ($1,$2,$3,$4,$5,$6,$7) returning ${COLUMNS}`,
    [id, tenantId, suggestionId, text, authorType, authorFingerprint, approvalStatus]
  );
  return mapRow(rows[0]);
}

async function approve(id, approvedBy = 'admin') {
  const { rows } = await query(
    `update comments
     set approval_status = 'approved', approved_at = now(), approved_by = $2,
         rejected_at = null, rejected_by = null
     where id = $1 returning ${COLUMNS}`,
    [id, approvedBy]
  );
  return mapRow(rows[0]);
}

async function reject(id, rejectedBy = 'admin') {
  const { rows } = await query(
    `update comments
     set approval_status = 'rejected', rejected_at = now(), rejected_by = $2
     where id = $1 returning ${COLUMNS}`,
    [id, rejectedBy]
  );
  return mapRow(rows[0]);
}

async function update(id, fields) {
  const { setClause, values, nextIndex } = buildUpdate(fields);
  if (!setClause) return findById(id);
  const { rows } = await query(
    `update comments set ${setClause} where id = $${nextIndex} returning ${COLUMNS}`,
    [...values, id]
  );
  return mapRow(rows[0]);
}

async function remove(id) {
  await query('delete from comments where id = $1', [id]);
}

module.exports = {
  findById, listApprovedForSuggestion, listForSuggestion, listPendingByTenant,
  create, approve, reject, update, remove,
};
