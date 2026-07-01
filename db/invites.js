'use strict';

// Repository für invites. Gibt Objekte im camelCase-Shape zurück.
const { query } = require('./pool');
const { mapRow, mapRows, buildUpdate } = require('./rows');

const COLUMNS = `
  id, tenant_id, email, role, status, token_hash,
  expires_at, accepted_at, revoked_at, created_at, updated_at
`;

async function findByTokenHash(tokenHash) {
  const { rows } = await query(
    `select ${COLUMNS} from invites where token_hash = $1`,
    [tokenHash]
  );
  return mapRow(rows[0]);
}

async function listByTenant(tenantId) {
  const { rows } = await query(
    `select ${COLUMNS} from invites where tenant_id = $1 order by created_at desc`,
    [tenantId]
  );
  return mapRows(rows);
}

async function findPending(tenantId, email) {
  const { rows } = await query(
    `select ${COLUMNS} from invites
     where tenant_id = $1 and email = $2 and status = 'pending'`,
    [tenantId, email]
  );
  return mapRow(rows[0]);
}

async function create({ id, tenantId, email, role, tokenHash, expiresAt }) {
  const { rows } = await query(
    `insert into invites (id, tenant_id, email, role, token_hash, expires_at, status)
     values ($1, $2, $3, $4, $5, $6, 'pending')
     returning ${COLUMNS}`,
    [id, tenantId, email, role, tokenHash, expiresAt]
  );
  return mapRow(rows[0]);
}

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from invites where id = $1`, [id]);
  return mapRow(rows[0]);
}

// Partielles Update; akzeptiert camelCase-Felder (status, acceptedAt, revokedAt).
async function update(id, fields) {
  const { setClause, values, nextIndex } = buildUpdate(fields);
  if (!setClause) return findById(id);
  const { rows } = await query(
    `update invites set ${setClause}, updated_at = now()
     where id = $${nextIndex} returning ${COLUMNS}`,
    [...values, id]
  );
  return mapRow(rows[0]);
}

async function remove(id) {
  await query('delete from invites where id = $1', [id]);
}

module.exports = {
  findByTokenHash, listByTenant, findPending, create, update, remove,
};
