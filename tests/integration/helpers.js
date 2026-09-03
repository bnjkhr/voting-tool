'use strict';

// Hilfen für DB-Integrationstests.
//
// ACHTUNG: Diese Suite schreibt echte Zeilen in die DB, auf die DATABASE_URL
// zeigt — Tenants, Boards, Suggestions, Kommentare, Attachments und API-Keys —
// und bootet die echte Express-App dagegen. .env.local zeigt im Zweifel auf die
// produktive Neon-DB. Deshalb reicht eine gesetzte DATABASE_URL NICHT: es
// braucht zusätzlich ALLOW_DB_TESTS=1 als bewusste Bestätigung, dass die
// Ziel-DB wegwerfbar ist.
//
// Der Opt-in steht bewusst NICHT im npm-Skript — sobald er dort steht, ist der
// Schutz wieder weg. Ohne DATABASE_URL bleibt alles wie bisher still (CI grün).
const fs = require('node:fs');
const path = require('node:path');

function loadEnv() {
  const repo = path.join(__dirname, '..', '..');
  for (const file of ['.env.local', '.env']) {
    const p = path.join(repo, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

loadEnv();

const dbConfigured = Boolean(process.env.DATABASE_URL);
const optedIn = process.env.ALLOW_DB_TESTS === '1';

// Wer eine DB konfiguriert hat, aber den Opt-in nicht gesetzt, soll nicht
// ratlos vor einer stillen Skip-Meldung stehen — sonst tauschen wir "schreibt
// unbemerkt in die Prod-DB" nur gegen "läuft unbemerkt nicht".
if (dbConfigured && !optedIn) {
  console.warn(
    'Integrationstests übersprungen: DATABASE_URL ist gesetzt, aber ALLOW_DB_TESTS=1 fehlt.\n'
    + 'Die Tests schreiben in die Ziel-DB — setze die Variable nur, wenn das eine Wegwerf-DB ist.'
  );
}

const hasDatabase = dbConfigured && optedIn;

module.exports = { loadEnv, hasDatabase };
