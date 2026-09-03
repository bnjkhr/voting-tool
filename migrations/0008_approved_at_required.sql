-- `approved = true` ohne approved_at ist eine halbfertige Zeile: Sortierung und
-- Audit-Anzeige lesen den Zeitstempel, und "seit wann freigegeben" ist bei einem
-- moderierten Board eine echte Frage. Der Repo-Create stempelt ihn bereits
-- (db/suggestions.js resolveApprovedAt), aber update() und der
-- Firestore-Import konnten die Kombination weiter schreiben.
--
-- Backfill zuerst: bestehende Zeilen ohne Zeitstempel bekommen created_at.
-- Das ist die beste verfuegbare Annaeherung — die Zeile existierte, und
-- freigegeben wurde sie irgendwann danach. Auf der Produktions-DB betrifft es
-- aktuell 0 Zeilen (vorab geprueft), der Backfill ist dort ein No-op.
update suggestions
   set approved_at = created_at
 where approved and approved_at is null;

alter table suggestions
  add constraint suggestions_approved_at_check
  check (not approved or approved_at is not null);
