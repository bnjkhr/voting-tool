-- Konsistenz: Status-Spalten begrenzen (cubic-Finding zu PR A). Ergänzt die
-- fehlenden CHECK-Constraints, damit ungültige Status-Werte DB-seitig abgewiesen
-- werden — analog zu invites/comments/releases.

alter table sessions
  add constraint sessions_status_check
  check (status in ('active','revoked','expired'));

alter table login_links
  add constraint login_links_status_check
  check (status in ('pending','consumed','expired'));

-- suggestions.status: Union aus Ticket- und Feature-Workflow-Werten.
alter table suggestions
  add constraint suggestions_status_check
  check (status in (
    'neu','offen','in Bearbeitung','im Test','wartend','gelöst','geschlossen',
    'wird geprüft','wird umgesetzt','ist umgesetzt','wird nicht umgesetzt'
  ));
