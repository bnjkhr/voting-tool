# Stripe-Setup (Billing / Pro-Plan)

Der Billing-Code ist hinter `STRIPE_SECRET_KEY` gegatet — ohne die Env-Vars ist
Billing komplett inaktiv (No-Op), die App läuft unverändert weiter. Zum
Scharfschalten die folgenden Schritte. Erst im **Test-Mode** durchspielen, dann
mit Live-Keys wiederholen.

## 1. In Stripe anlegen
1. Stripe-Konto → **Test-Mode** aktivieren (Toggle oben rechts).
2. **Produkt** „Roadlight Pro" mit einem wiederkehrenden **Preis** (monatlich, EUR).
   Betrag: **9,00 EUR**, keine Testphase, keine nutzungsabhängige Abrechnung.
   Die **Price-ID** (`price_…`) notieren → das ist `STRIPE_PRICE_PRO`.
3. **API-Keys** (Developers → API keys): den **Secret Key** (`sk_test_…`) →
   `STRIPE_SECRET_KEY`.
4. **Customer Portal** aktivieren (Settings → Billing → Customer portal → Speichern),
   Kündigung zum Periodenende und Aktualisierung der Zahlungsart erlauben, sonst
   schlägt „Abo verwalten" fehl.
5. Die Roadlight-AGB und Datenschutzerklärung werden im produktinternen
   Zustimmungsdialog vor Stripe verlinkt und die Zustimmung serverseitig
   versioniert protokolliert. Im gemeinsam mit FamilyManager verwendeten
   Stripe-Konto keine Roadlight-spezifische kontoweite AGB-URL setzen.
6. Stripe Tax bleibt aus. Der Webhook setzt bei `invoice.created` den Hinweis
   „Gemäß § 19 UStG wird keine Umsatzsteuer berechnet." auf die noch nicht
   finalisierte Roadlight-Rechnung. Damit trägt jede Roadlight-Rechnung den
   Hinweis, ohne die kontoweiten FamilyManager-Einstellungen zu verändern.
7. Der Restricted Key benötigt dafür zusätzlich **Invoices: Write**.

## 2. Webhook einrichten
1. Developers → **Webhooks** → Endpoint hinzufügen:
   `https://roadlight.pro/api/stripe/webhook`
2. Events auswählen: `checkout.session.completed`, `invoice.created`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`,
   `invoice.payment_action_required`, `invoice.finalization_failed`.
3. Das **Signing Secret** (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.

## 3. Env-Vars setzen (roadlight-Projekt)
Lokal in `.env.local` (zum Testen) und in Vercel (Production):
```
STRIPE_SECRET_KEY=sk_test_…      (bzw. sk_live_… für Production)
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_PRO=price_…
STRIPE_PORTAL_CONFIGURATION=bpc_…
BILLING_ENFORCED=false
```

`STRIPE_PORTAL_CONFIGURATION` verweist auf eine eigene Roadlight-Konfiguration,
damit Legal-Links, Rücksprung-URL und Kündigungsoptionen nicht von anderen Produkten
im selben Stripe-Konto übernommen werden.

> **Master-Schalter `BILLING_ENFORCED`** (Default: aus): Steuert, ob Pro-Features
> (aktuell API-/MCP-Zugriff) tatsächlich gesperrt werden. Bewusst **getrennt**
> von `STRIPE_SECRET_KEY`, damit das Anbinden/Testen von Stripe das Gating nicht
> versehentlich scharf schaltet. Solange `BILLING_ENFORCED` ≠ `true`, haben
> **alle** Workspaces vollen Zugriff auf Pro-Features (jeder ist effektiv Pro).
> Erst beim offiziellen Premium-Launch `BILLING_ENFORCED=true` setzen.

## 4. Lokal testen (Stripe CLI)
```
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook   # liefert ein whsec_ für lokal
# in einem Board als Owner: "Upgrade" -> Checkout mit Test-Karte 4242 4242 4242 4242
```
Der zuverlässige Test ist ein **echter Checkout** (Test-Karte) — nur er trägt die
Tenant-Zuordnung (`client_reference_id` / `subscription_data.metadata.tenantId`),
die der Webhook-Handler zum Update von `tenants` braucht. Ein blankes
`stripe trigger checkout.session.completed` läuft dagegen **ins Leere** (kein
Tenant-Bezug → der Handler macht `return`, ohne einen Tenant zu ändern).
Nach erfolgreichem Checkout sollte in Neon `tenants.plan = 'pro'`,
`subscription_status = 'active'`, `stripe_customer_id`/`current_period_end`
gesetzt sein.

Die Tabelle `billing_checkout_sessions` serialisiert parallele Checkout-Versuche
pro Workspace und protokolliert die akzeptierte AGB-Version. Webhook-Event-IDs
werden in `stripe_webhook_events` dedupliziert; laufende Zustellungen werden noch
nicht mit 2xx quittiert und verwaiste Claims nach fünf Minuten übernommen.

## Datenbankmigration vor Vercel

Vor dem Deployment einmal `npm run db:migrate` mit der Ziel-Datenbank ausführen.
Der Migrator ist idempotent und nutzt einen Postgres-Advisory-Lock. Er läuft bewusst
nicht in `vercel-build`: Vercel behandelt die Hilfsdateien unter `api/` als einzelne
Functions und würde den Build-Hook mehrfach starten. Migrationen müssen additiv und
rückwärtskompatibel bleiben, weil Preview und Production dieselbe Datenbank nutzen
können.

## Endpoints (bereits gebaut)
- `POST /api/stripe/webhook` — Signatur-verifiziert, synct Abo-Status → `tenants` (nur Postgres).
- `GET  /api/admin/tenants/:slug/billing` — aktueller Plan/Status (Mitglieder).
- `POST /api/admin/tenants/:slug/billing/checkout` — Checkout-Session (Owner).
- `POST /api/admin/tenants/:slug/billing/portal` — Customer Portal (Owner).

## Gating (Pro-Features)
Alle Pro-Gates laufen über `billing.requiresProUpgrade(tenant, {postgres})` und
greifen **nur** bei `BILLING_ENFORCED=true` (+ Stripe + Postgres). Bis dahin ist
jeder effektiv Pro. Downgrade ist kulant: bestehende Daten bleiben, nur Neu-Anlage
über dem Limit wird gesperrt.
- **API & MCP:** Erstellung *und* Nutzung von API-Schlüsseln (`402`, Keys bleiben,
  Upgrade reaktiviert).
- **Boards:** Free = max. **1 Board**. 2. Board → `402 upgrade_required`.
- **Team:** Free = max. **2 Mitglieder** (aktive + offene Einladungen). 3. → `402`.
- **Badge:** „Powered by Roadlight" auf dem öffentlichen Board im Free-Plan.
- Limits zentral in `lib/plan-limits.js`. Die Konsole zeigt die Auslastung
  („1/1 Board, 2/2 Mitglieder") aus dem `usage`-Feld von `GET …/billing`.

## Steuer: Kleinunternehmer (§ 19 UStG)
Der Betreiber ist Kleinunternehmer nach § 19 UStG → **keine Umsatzsteuer**. 9 € ist
ein Endpreis (brutto = netto). In Stripe daher:
- **Stripe Tax: aus** (keine Steuerberechnung/-position).
- Rechnungs-Einstellungen: den **§ 19-Hinweis** hinterlegen (z. B. „Gemäß § 19 UStG
  wird keine Umsatzsteuer berechnet."), keine USt-Zeile.

## Live schalten (Premium-Launch) — Checkliste
1. **Bezahl-AGB** (`docs/agb-pro-entwurf.md`) anwaltlich prüfen lassen → als
   `public/agb.html` live; Impressum/Datenschutz auf Stripe/Bezahlung prüfen.
2. Verbraucher-Vertrieb nur mit geprüftem Widerrufs- und Kündigungsprozess
   (§ 312k BGB); alternativ den Start technisch und vertraglich auf B2B begrenzen.
3. Stripe **Live-Mode**: Produkt/Preis (9 €/Monat, keine Steuer) + Webhook auf
   `roadlight.pro` neu anlegen, Live-Keys ziehen.
4. In Vercel (roadlight): `STRIPE_SECRET_KEY=sk_live_…`, `STRIPE_WEBHOOK_SECRET`,
   `STRIPE_PRICE_PRO` setzen.
5. Test-Checkout, Webhook, Portal, Kündigung und Downgrade in Stripe-Testmode
   vollständig prüfen.
6. **Zuletzt** `BILLING_ENFORCED=true` setzen → ab jetzt greifen alle Limits.
