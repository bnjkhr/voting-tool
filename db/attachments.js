'use strict';

// Repository für attachments (ersetzt base64-Screenshots; verweist per
// storage_key auf externen Blob-Storage). Gibt Objekte im camelCase-Shape
// zurück. Die id wird von der DB generiert (gen_random_uuid()).
const { query } = require('./pool');
const { mapRow, mapRows } = require('./rows');

const COLUMNS = `
  id, tenant_id, parent_type, parent_id, storage_key, content_type, size_bytes, created_at
`;

async function create({ tenantId, parentType, parentId, storageKey, contentType, sizeBytes }) {
  const { rows } = await query(
    `insert into attachments (tenant_id, parent_type, parent_id, storage_key, content_type, size_bytes)
     values ($1, $2, $3, $4, $5, $6)
     returning ${COLUMNS}`,
    [tenantId, parentType, parentId, storageKey, contentType || null, sizeBytes ?? null]
  );
  return mapRow(rows[0]);
}

async function listForParent(parentType, parentId) {
  const { rows } = await query(
    `select ${COLUMNS} from attachments
     where parent_type = $1 and parent_id = $2 order by created_at asc`,
    [parentType, parentId]
  );
  return mapRows(rows);
}

async function removeForParent(parentType, parentId) {
  await query(
    'delete from attachments where parent_type = $1 and parent_id = $2',
    [parentType, parentId]
  );
}

module.exports = {
  create, listForParent, removeForParent,
};
