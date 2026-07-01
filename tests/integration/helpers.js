'use strict';

// Hilfen für DB-Integrationstests gegen Neon. Lädt .env.local/.env, damit
// DATABASE_URL gesetzt ist; wenn keine DB konfiguriert ist, werden die Tests
// übersprungen (CI ohne DB bleibt grün).
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

const hasDatabase = Boolean(process.env.DATABASE_URL);

module.exports = { loadEnv, hasDatabase };
