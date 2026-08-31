'use strict';

// Free-Plan-Limits — nur die konkreten Zahlen. Die Entscheidung, OB überhaupt
// gegatet wird, trifft lib/billing.js (billing.requiresProUpgrade), das den
// Master-Schalter BILLING_ENFORCED respektiert: solange Premium nicht live ist,
// hat jeder Workspace vollen Zugriff (Beta bleibt unangetastet). Hier leben nur
// die Grenzen, damit Enforcement (Server) und Anzeige (Client) dieselbe Quelle
// teilen. Pro = keine Limits.

const FREE_MAX_BOARDS = 1;
const FREE_MAX_MEMBERS = 2; // aktive Mitglieder + offene Einladungen zusammen

module.exports = {
  FREE_MAX_BOARDS,
  FREE_MAX_MEMBERS,
};
