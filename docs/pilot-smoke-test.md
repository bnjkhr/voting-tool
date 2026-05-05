# Friendly User Pilot Smoke Test

Ziel: vor dem Versand an Friendly User einmal belegen, dass Beta, Tenant-Isolation, Login, Rollen und Public Board zusammen funktionieren.

## Voraussetzung

- Beta-Link ist `https://beta.votingtool.benkohler.de`.
- Der Pilot läuft nicht über `legacy` und nicht über `/admin.html`.
- Pilot-Tenant ist aktiv und hat mindestens ein Board.
- Einladungs- und Login-Mails zeigen auf die Beta-Domain.
- Feedback-Kanal ist vorab festgelegt.

## 1. Tenant-Isolation

- Im Super Admin den Pilot-Tenant öffnen.
- Im Tenant Admin prüfen: Header zeigt richtigen Workspace, Rolle und Tenant.
- Public Board über `/?tenant=<slug>` öffnen.
- Sicherstellen: keine internen Boards, keine fremden Kundenboards, keine Legacy-Testboards sichtbar.
- Gegenprobe mit zweitem Tenant öffnen: Boards dürfen sich nicht vermischen.

## 2. Owner-Flow

- Als Owner per `/login.html` anmelden.
- Tenant Admin öffnen.
- Workspace Settings prüfen.
- Neues Board erstellen.
- Public-Link dieses Boards öffnen.
- Einen Testeintrag erstellen.

## 3. Invite/Login

- Eine reale Friendly-User-Mail als `admin` einladen.
- Optional zweite Person als `viewer` einladen.
- Invite-Mail prüfen: Absender, Link, Beta-Domain.
- Invite annehmen.
- Danach erneut über `/login.html` einloggen.
- Prüfen: User landet im richtigen Tenant Admin.

## 4. Rollen

- Owner kann Workspace, Team, Boards und Moderation bearbeiten.
- Admin kann Einträge moderieren, Status und Priorität ändern.
- Viewer sieht Admin-Kontext, aber keine gefährlichen Schreibaktionen.
- Kein User sieht Super Admin oder fremde Tenants.

## 5. Public Board

- Feature erstellen.
- Bug oder Ticket erstellen.
- Vote setzen und entfernen.
- Kommentar schreiben.
- Kommentar im Tenant Admin moderieren.
- Status und Priorität ändern.

## 6. Abbruchkriterien

Pilot nicht starten oder pausieren, wenn eines davon eintritt:

- Ein Friendly User sieht fremde Tenants oder Boards.
- Invite/Login-Link zeigt auf Live oder eine falsche Vercel-Preview.
- Tenant Admin zeigt unklaren Workspace oder falsche Rolle.
- Public Board lädt Legacy-Daten im Pilot-Kontext.
- E-Mail-Versand ist unzuverlässig oder landet reproduzierbar im Spam.

## 7. Rollback

- Offene Invites widerrufen.
- Friendly-User-Mitgliedschaften deaktivieren.
- Pilot-Tenant im Super Admin nicht löschen, solange Fehleranalyse offen ist.
- Bei Auth-Problemen globales `ADMIN_PASSWORD` nur als Betreiber-Fallback verwenden.
