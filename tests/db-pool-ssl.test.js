'use strict';

// TLS zur Datenbank ist Standard und muss es bleiben. Abschaltbar ist es nur
// fuer einen lokalen oder CI-Postgres-Container ohne Zertifikat — und zwar
// ausschliesslich ueber den exakten Wert PGSSLMODE=disable.
//
// Der Test haelt die Richtung fest: alles andere, auch Tippfehler und
// Schreibvarianten, laesst TLS AN. Eine Aufweichung zu "irgendein truthy Wert
// schaltet ab" wuerde hier rot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { sslDisabled } = require('../db/pool');
const poolSource = fs.readFileSync(path.join(__dirname, '..', 'db/pool.js'), 'utf8');

function withPgSslMode(value, fn) {
  const previous = process.env.PGSSLMODE;
  if (value === undefined) delete process.env.PGSSLMODE;
  else process.env.PGSSLMODE = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.PGSSLMODE;
    else process.env.PGSSLMODE = previous;
  }
}

test('nur der exakte Wert "disable" schaltet TLS ab', () => {
  withPgSslMode('disable', () => assert.equal(sslDisabled(), true));
});

test('jeder andere Wert laesst TLS an (fail-safe)', () => {
  // Schreibvarianten, Tippfehler, "falsy" aussehende Werte und der ungesetzte
  // Fall duerfen TLS NICHT abschalten.
  for (const value of [undefined, '', ' ', 'Disable', 'DISABLE', 'disabled', 'disable ', 'require', 'false', '0', 'no', 'off', 'true', '1']) {
    withPgSslMode(value, () => {
      assert.equal(sslDisabled(), false, `PGSSLMODE=${JSON.stringify(value)} darf TLS nicht abschalten`);
    });
  }
});

test('der Pool leitet die Entscheidung aus sslDisabled() ab, nicht aus einem eigenen Check', () => {
  assert.ok(
    poolSource.includes('ssl: sslDisabled() ? false : true'),
    'getPool muss ueber sslDisabled() entscheiden'
  );
  // Kein zweiter, abweichender Env-Zugriff auf PGSSLMODE — sonst koennten Pool
  // und Migrations-Runner unterschiedlich entscheiden.
  assert.equal(
    (poolSource.match(/process\.env\.PGSSLMODE/g) || []).length, 1,
    'PGSSLMODE darf nur an einer Stelle gelesen werden'
  );
});

test('der Migrations-Runner nutzt dieselbe Entscheidung wie der Pool', () => {
  const migrateSource = fs.readFileSync(path.join(__dirname, '..', 'scripts/migrate-db.js'), 'utf8');
  assert.ok(
    migrateSource.includes("require('../db/pool')") && migrateSource.includes('sslDisabled'),
    'migrate-db.js muss sslDisabled aus db/pool importieren statt eigen zu pruefen'
  );
  assert.equal(
    migrateSource.includes('ssl: true }'), false,
    'kein hart verdrahtetes ssl: true mehr im Migrations-Runner'
  );
});
