'use strict';

// Geteilte Helfer für die quelltextbasierten Tests in diesem Verzeichnis.
//
// Wichtig ist die Anker-Prüfung: ein `source.slice(indexOf(a), indexOf(b))` mit
// einem verschobenen Marker liefert `indexOf` === -1 und damit still fast die
// ganze Datei — die Assertions darauf werden dann grün, ohne noch etwas zu
// prüfen. Deshalb schlagen hier fehlende Anker sofort und laut fehl.
const assert = require('node:assert/strict');

const NEXT_TOP_LEVEL = /\n(async function |function |const |app\.(get|post|put|patch|delete|use)\()/;

// Body einer benannten (async) Funktion bis zur nächsten Top-Level-Deklaration.
function functionBody(source, name) {
  const signature = [`async function ${name}(`, `function ${name}(`]
    .find(candidate => source.includes(candidate));
  assert.ok(signature, `Funktion nicht gefunden: ${name}`);

  const rest = source.slice(source.indexOf(signature) + signature.length);
  const next = rest.search(NEXT_TOP_LEVEL);
  assert.ok(next > 0, `Ende von ${name} nicht gefunden`);
  return rest.slice(0, next);
}

// Body eines Express-Handlers ab seiner Route-Signatur bis zur nächsten Route.
function handlerAfter(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `Route nicht gefunden: ${signature}`);

  const rest = source.slice(start + signature.length);
  const next = rest.search(/\napp\.(get|post|put|patch|delete|use)\(/);
  return rest.slice(0, next > -1 ? next : rest.length);
}

module.exports = { functionBody, handlerAfter };
