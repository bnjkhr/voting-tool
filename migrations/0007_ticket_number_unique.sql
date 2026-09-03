-- Ticketnummern sind pro Board eindeutig — bisher nur durch einen SELECT im
-- Import-Pfad zugesichert (db/suggestions.js createWithImportedTicketNumber).
-- Das ist ein Check-then-Insert: zwei parallele Importe derselben Nummer sehen
-- unter READ COMMITTED beide "kein Duplikat" und fügen beide ein. Genau der
-- Fall, der beim Massenimport eines gewachsenen Boards auftritt.
--
-- Der Index macht die Zusicherung zur DB-Garantie; der Anwendungscode fängt die
-- Verletzung ab und antwortet weiterhin mit 409 statt 500.
--
-- ticket_number ist nullable (Altbestand ohne Nummer). In Postgres kollidieren
-- NULLs in einem Unique-Index nicht, mehrere Zeilen ohne Nummer bleiben also
-- erlaubt. Der partielle WHERE macht das explizit und hält den Index klein.
create unique index if not exists suggestions_app_ticket_number_uidx
  on suggestions (app_id, ticket_number)
  where ticket_number is not null;
