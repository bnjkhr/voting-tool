-- Status zurückschreiben (Stufe 2). Je Quelle ein Schalter, ab Werk aus. Je
-- Verknüpfung die wartende Änderung und ein Anspruch (push_claim): Nur wer ihn
-- hält, schreibt öffentlich oder verschickt die Mail. Gespeichert wird nur, ob
-- eine Mail ginge, nie an wen.
-- Rein additiv: Ältere Code-Stände kennen die Spalten nicht.

alter table feedback_sources add column push_enabled bool not null default false;
alter table feedback_links
  add column pending_reason text check (pending_reason in ('mail','backward','failed','busy')),
  add column pending_mail bool not null default false,
  add column pending_error text,
  add column pending_at timestamptz,
  add column push_claim text,
  add column push_claimed_at timestamptz,
  add column push_stage text check (push_stage in ('writing','mailing')),
  add column pushed_status text,
  add column pushed_at timestamptz,
  add constraint feedback_links_pending_ck check ((pending_status is null) = (pending_reason is null)),
  add constraint feedback_links_claim_ck check ((push_claim is null) = (push_stage is null));
