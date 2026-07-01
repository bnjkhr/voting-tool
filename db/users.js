'use strict';

// Repository für users. Gibt Objekte im camelCase-Shape zurück, damit die
// Verdrahtung im App-Code minimal bleibt.
const { query } = require('./pool');
const { mapRow, buildUpdate } = require('./rows');

const COLUMNS = `
  id, email, display_name, status, created_at, updated_at
`;

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from users where id = $1`, [id]);
  return mapRow(rows[0]);
}

// email ist citext -> Vergleich ist case-insensitive.
async function findByEmail(email) {
  const { rows } = await query(`select ${COLUMNS} from users where email = $1`, [email]);
  return mapRow(rows[0]);
}

async function create({ id, email, displayName }) {
  const { rows } = await query(
    `insert into users (id, email, display_name)
     values ($1, $2, $3)
     returning ${COLUMNS}`,
    [id, email, displayName || null]
  );
  return mapRow(rows[0]);
}

// Partielles Update; akzeptiert camelCase-Felder (z.B. displayName, status).
// updated_at wird immer gesetzt.
async function update(id, fields) {
  const { setClause, values, nextIndex } = buildUpdate(fields);
  if (!setClause) return findById(id);
  const { rows } = await query(
    `update users set ${setClause}, updated_at = now()
     where id = $${nextIndex} returning ${COLUMNS}`,
    [...values, id]
  );
  return mapRow(rows[0]);
}

module.exports = {
  findById, findByEmail, create, update,
};
