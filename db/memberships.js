'use strict';

// Repository für memberships (User <-> Tenant mit Rolle). Gibt Objekte im
// camelCase-Shape zurück.
const { query } = require('./pool');
const { mapRow, mapRows, buildUpdate } = require('./rows');

const COLUMNS = `
  id, tenant_id, user_id, role, status, disabled_at, created_at, updated_at
`;

async function findByTenantAndUser(tenantId, userId) {
  const { rows } = await query(
    `select ${COLUMNS} from memberships where tenant_id = $1 and user_id = $2`,
    [tenantId, userId]
  );
  return mapRow(rows[0]);
}

async function listByTenant(tenantId) {
  const { rows } = await query(
    `select ${COLUMNS} from memberships where tenant_id = $1 order by created_at asc`,
    [tenantId]
  );
  return mapRows(rows);
}

async function listActiveAdmins(tenantId) {
  const { rows } = await query(
    `select ${COLUMNS} from memberships
     where tenant_id = $1 and status = 'active' and role in ('owner','admin')
     order by created_at asc`,
    [tenantId]
  );
  return mapRows(rows);
}

async function listByUser(userId) {
  const { rows } = await query(
    `select ${COLUMNS} from memberships where user_id = $1 and status = 'active'
     order by created_at asc`,
    [userId]
  );
  return mapRows(rows);
}

async function create({ id, tenantId, userId, role }) {
  const { rows } = await query(
    `insert into memberships (id, tenant_id, user_id, role)
     values ($1, $2, $3, $4)
     returning ${COLUMNS}`,
    [id, tenantId, userId, role]
  );
  return mapRow(rows[0]);
}

// Partielles Update; akzeptiert camelCase-Felder (z.B. role, status, disabledAt).
// updated_at wird immer gesetzt.
async function update(id, fields) {
  const { setClause, values, nextIndex } = buildUpdate(fields);
  if (!setClause) return findById(id);
  const { rows } = await query(
    `update memberships set ${setClause}, updated_at = now()
     where id = $${nextIndex} returning ${COLUMNS}`,
    [...values, id]
  );
  return mapRow(rows[0]);
}

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from memberships where id = $1`, [id]);
  return mapRow(rows[0]);
}

// Anzahl aktiver Owner im Tenant (für Last-Owner-Schutz).
async function countActiveOwners(tenantId) {
  const { rows } = await query(
    `select count(*)::int as count from memberships
     where tenant_id = $1 and role = 'owner' and status = 'active'`,
    [tenantId]
  );
  return rows[0].count;
}

async function remove(id) {
  await query('delete from memberships where id = $1', [id]);
}

module.exports = {
  findByTenantAndUser,
  listByTenant,
  listActiveAdmins,
  listByUser,
  create,
  update,
  countActiveOwners,
  remove,
};
