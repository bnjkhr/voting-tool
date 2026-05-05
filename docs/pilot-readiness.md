# Friendly User Pilot Readiness

Ziel: 1-2 befreundete Personen testen einen echten, isolierten Pilot-Tenant. Legacy bleibt unverändert.

## Pilot-Tenant

- Friendly User über `/signup.html` selbst einen Workspace anlegen lassen, wenn der Test wie ein echter Subscriber-Flow wirken soll.
- Alternativ als Betreiber einen echten Tenant anlegen, z. B. `pilot-ben` oder kundennahen Slug.
- Keine Smoke-Test-Texte verwenden.
- Erstes Board sinnvoll benennen.
- Im Tenant Admin mindestens ein eigenes zusätzliches Board erstellen.
- Public Board öffnen und prüfen, ob nur Tenant-Daten sichtbar sind.

## Invite/Login

- Owner-Zugang zuerst selbst per E-Mail-Login testen.
- Friendly User als `admin` einladen, wenn sie moderieren sollen.
- Friendly User als `viewer` einladen, wenn sie nur Admin-Kontext sehen sollen.
- Einladungsannahme testen: Invite-Link, Session, Redirect in den Tenant Admin.
- Login später erneut über `/login.html` mit E-Mail-Link testen.

## Rollen

- Owner: Workspace Settings, Team, Rollen und alle Moderationsaktionen.
- Admin: Einträge moderieren, Status/Priorität pflegen, Kommentare bearbeiten.
- Viewer: lesen, aber keine gefährlichen Schreibaktionen.

## Public Smoke Test

- Feature erstellen.
- Bug oder Ticket erstellen.
- Vote setzen und wieder entfernen.
- Kommentar abschicken und im Admin moderieren.
- Status und Priorität ändern.

## Feedback

- Vor dem Test einen festen Feedback-Kanal vereinbaren.
- Friendly User sollen Screenshots plus URL schicken.
- Fehler notieren mit Rolle, Tenant, Browser und Aktion.

## Rollback

- Bei Problemen Friendly User aus dem Tenant deaktivieren.
- Offene Invites widerrufen.
- Pilot-Tenant nicht mit `legacy` vermischen.
- Bei schwerem Auth-Problem temporär den globalen `ADMIN_PASSWORD` als Betreiber-Fallback nutzen.
