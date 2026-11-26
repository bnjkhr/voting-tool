-- Privater Workspace: Status `private` zulassen. Öffentliche Routen verlangen
-- weiter `active`, nur angemeldete Wege sehen zusätzlich `private`. Ältere
-- Code-Stände behandeln einen privaten Workspace als nicht aktiv, deshalb darf
-- die erweiterte Prüfregel bei einem Zurückrollen bestehen bleiben.

alter table tenants drop constraint if exists tenants_status_check;
alter table tenants add constraint tenants_status_check
  check (status in ('active','suspended','trialing','past_due','canceled','private'));
