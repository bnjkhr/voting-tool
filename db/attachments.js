'use strict';

// Repository für attachments (ersetzt die base64-Screenshots[] im Firestore-Doc).
// Die Bytes liegen inline in der data-Spalte (bytea); ausgeliefert werden sie
// über einen Proxy-Endpoint. storage_key bleibt für eine spätere R2-Migration
// reserviert. Gibt Objekte im camelCase-Shape zurück (die id ist eine
// DB-generierte uuid). data wird bewusst NICHT in den Metadaten-Queries
// mitgeladen — nur der Proxy holt die Bytes.
const { query } = require('./pool');
const { mapRow, mapRows } = require('./rows');

// Metadaten ohne die (potenziell große) data-Spalte.
const META = `
  id, tenant_id, parent_type, parent_id, storage_key, content_type, size_bytes, created_at
`;

async function create({ tenantId, parentType, parentId, data, contentType, sizeBytes }) {
  const { rows } = await query(
    `insert into attachments (tenant_id, parent_type, parent_id, data, content_type, size_bytes)
     values ($1, $2, $3, $4, $5, $6)
     returning ${META}`,
    [tenantId, parentType, parentId, data, contentType || null, sizeBytes ?? (data ? data.length : null)]
  );
  return mapRow(rows[0]);
}

async function listForParent(parentType, parentId) {
  const { rows } = await query(
    `select ${META} from attachments
     where parent_type = $1 and parent_id = $2 order by created_at asc`,
    [parentType, parentId]
  );
  return mapRows(rows);
}

// Batch-Variante: alle Attachments für mehrere Parents auf einmal (vermeidet
// N+1 beim Rendern von Listen). tenant-gescopt — sonst könnten bei einer
// polymorphen parent_id-Kollision fremde Attachments in die URL-Liste geraten.
// Rückgabe chronologisch, damit der Aufrufer je parent_id gruppieren kann.
async function listForParents(parentType, parentIds, tenantId) {
  if (!parentIds || parentIds.length === 0) return [];
  const { rows } = await query(
    `select ${META} from attachments
     where parent_type = $1 and parent_id = any($2::text[]) and tenant_id = $3
     order by created_at asc`,
    [parentType, parentIds, tenantId]
  );
  return mapRows(rows);
}

// Für den Proxy-Endpoint: Metadaten + Bytes. tenant-gescopt als
// Defense-in-depth gegen Cross-Tenant-Zugriff über geratene/geleakte IDs.
async function findWithData(id, tenantId) {
  const { rows } = await query(
    `select ${META}, data from attachments where id = $1 and tenant_id = $2`,
    [id, tenantId]
  );
  return mapRow(rows[0]);
}

async function removeForParent(parentType, parentId) {
  await query(
    'delete from attachments where parent_type = $1 and parent_id = $2',
    [parentType, parentId]
  );
}

module.exports = {
  create, listForParent, listForParents, findWithData, removeForParent,
};
