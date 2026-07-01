'use strict';

// Repository für releases (Roadmap-Einträge je Board). Ersetzt die frühere
// Firestore-Collection; Rückgabe im bisherigen camelCase-Shape (mapRow).
const { query } = require('./pool');
const { mapRow, mapRows, buildUpdate } = require('./rows');

const COLUMNS = `
  id, tenant_id, app_id, version, title, description, status,
  release_date, published_at, created_at, updated_at
`;

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from releases where id = $1`, [id]);
  return mapRow(rows[0]);
}

async function listByApp(appId) {
  const { rows } = await query(
    `select ${COLUMNS} from releases where app_id = $1 order by created_at desc`,
    [appId]
  );
  return mapRows(rows);
}

async function listPublishedByApp(appId) {
  const { rows } = await query(
    `select ${COLUMNS} from releases
     where app_id = $1 and status = 'veröffentlicht'
     order by published_at desc nulls last, created_at desc`,
    [appId]
  );
  return mapRows(rows);
}

async function create({ id, tenantId, appId, version = null, title, description = '', status = 'geplant', releaseDate = null }) {
  const { rows } = await query(
    `insert into releases (id, tenant_id, app_id, version, title, description, status, release_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning ${COLUMNS}`,
    [id, tenantId, appId, version, title, description, status, releaseDate]
  );
  return mapRow(rows[0]);
}

async function update(id, fields) {
  const { setClause, values, nextIndex } = buildUpdate(fields);
  if (!setClause) return findById(id);
  const { rows } = await query(
    `update releases set ${setClause}, updated_at = now()
     where id = $${nextIndex} returning ${COLUMNS}`,
    [...values, id]
  );
  return mapRow(rows[0]);
}

// Setzt den Release auf 'veröffentlicht' und stempelt published_at.
async function setPublished(id) {
  const { rows } = await query(
    `update releases set status = 'veröffentlicht', published_at = now(), updated_at = now()
     where id = $1 returning ${COLUMNS}`,
    [id]
  );
  return mapRow(rows[0]);
}

async function remove(id) {
  // suggestions.release_id wird per ON DELETE SET NULL automatisch geleert.
  await query('delete from releases where id = $1', [id]);
}

module.exports = {
  findById, listByApp, listPublishedByApp, create, update, setPublished, remove,
};
