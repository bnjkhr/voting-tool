'use strict';

// Schaltet die Datenhaltung zwischen Firestore (Default) und Postgres/Neon um.
// Solange DATA_BACKEND != 'postgres', bleibt alles auf Firestore — ein Merge auf
// main bricht roadlight also NICHT, bevor die Datenmigration (PR E) gelaufen ist.
function usePostgres() {
  return process.env.DATA_BACKEND === 'postgres';
}

module.exports = { usePostgres };
