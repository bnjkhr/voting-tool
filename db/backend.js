'use strict';

// Schaltet die Datenhaltung zwischen Firestore und Postgres/Neon um.
//
// STAND: Der Cutover ist am 2026-07-02 gelaufen. roadlight.pro laeuft in
// Produktion auf Neon Postgres (DATA_BACKEND=postgres in der Vercel-Env des
// roadlight-Projekts). Firestore ist nur noch die Quelle fuer Legacy
// (votingtool.benkohler.de, tenantId 'legacy') — dort ist DATA_BACKEND nicht
// gesetzt, deshalb bleibt 'firestore' der Default dieser Funktion.
//
// Daraus folgt: Ein Pfad ohne usePostgres()-Weiche ist KEIN latenter Fehler,
// der erst beim Cutover schlagend wird — er ist in Produktion bereits falsch.
// Genau diese Fehlannahme hat 2026-09 dazu gefuehrt, dass API-Keys nach
// Postgres geschrieben, aber aus Firestore gelesen wurden und sich deshalb
// kein Key authentifizieren konnte (behoben in #76).
//
// Schneller Beleg, was Produktion tatsaechlich nutzt: einen Tenant-Slug, den
// nur Neon kennt, gegen roadlight.pro/api/tenants/<slug> pruefen (200 =
// Postgres ist live).
function usePostgres() {
  return process.env.DATA_BACKEND === 'postgres';
}

module.exports = { usePostgres };
