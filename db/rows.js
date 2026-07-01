'use strict';

// Wandelt DB-Zeilen (snake_case) in das camelCase-Shape, das der bestehende
// App-Code erwartet (wie bisher die Firestore-Dokumente). Postgres liefert
// timestamptz bereits als JS-Date — passt zum vorhandenen toDate()-Handling.

function toCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function toSnake(key) {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function mapRow(row) {
  if (!row) return null;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    out[toCamel(k)] = v;
  }
  return out;
}

function mapRows(rows) {
  return (rows || []).map(mapRow);
}

// Baut aus einem camelCase-Feld→Wert-Objekt ein UPDATE-Fragment
// ("col1 = $1, col2 = $2", [v1, v2]) mit snake_case-Spalten.
function buildUpdate(fields, startIndex = 1) {
  const cols = [];
  const values = [];
  let i = startIndex;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    cols.push(`${toSnake(k)} = $${i++}`);
    values.push(v);
  }
  return { setClause: cols.join(', '), values, nextIndex: i };
}

module.exports = { toCamel, toSnake, mapRow, mapRows, buildUpdate };
