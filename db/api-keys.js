'use strict';

// Repository für api_keys. Gibt Objekte im camelCase-Shape zurück.
const { query } = require('./pool');
const { mapRow, mapRows } = require('./rows');

const COLUMNS = `
  id, tenant_id, name, scopes, token_hash, token_prefix,
  created_by, last_used_at, revoked_at, created_at
`;

async function findByTokenHash(tokenHash) {
  const { rows } = await query(
    `select ${COLUMNS} from api_keys where token_hash = $1`,
    [tokenHash]
  );
  return mapRow(rows[0]);
}

async function listByTenant(tenantId) {
  const { rows } = await query(
    `select ${COLUMNS} from api_keys where tenant_id = $1 order by created_at desc`,
    [tenantId]
  );
  return mapRows(rows);
}

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from api_keys where id = $1`, [id]);
  return mapRow(rows[0]);
}

async function create({ id, tenantId, name, scopes = [], tokenHash, tokenPrefix, createdBy }) {
  const { rows } = await query(
    `insert into api_keys (id, tenant_id, name, scopes, token_hash, token_prefix, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning ${COLUMNS}`,
    [id, tenantId, name, scopes, tokenHash, tokenPrefix, createdBy]
  );
  return mapRow(rows[0]);
}

async function touch(id) {
  const { rows } = await query(
    `update api_keys set last_used_at = now()
     where id = $1 returning ${COLUMNS}`,
    [id]
  );
  return mapRow(rows[0]);
}

async function revoke(id) {
  const { rows } = await query(
    `update api_keys set revoked_at = now()
     where id = $1 returning ${COLUMNS}`,
    [id]
  );
  return mapRow(rows[0]);
}

module.exports = {
  findByTokenHash, listByTenant, findById, create, touch, revoke,
};
