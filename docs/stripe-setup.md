# Stripe-Setup (Billing / Pro-Plan)

Der Billing-Code ist hinter `STRIPE_SECRET_KEY` gegatet — ohne die Env-Vars ist
Billing komplett inaktiv (No-Op), die App läuft unverändert weiter. Zum
Scharfschalten die folgenden Schritte. Erst im **Test-Mode** durchspielen, dann
mit Live-Keys wiederholen.

## 1. In Stripe anlegen
1. Stripe-Konto → **Test-Mode** aktivieren (Toggle oben rechts).
2. **Produkt** „Roadlight Pro" mit einem wiederkehrenden **Preis** (monatlich, EUR).
   Die **Price-ID** (`price_…`) notieren → das ist `STRIPE_PRICE_PRO`.
3. **API-Keys** (Developers → API keys): den **Secret Key** (`sk_test_…`) →
   `STRIPE_SECRET_KEY`.
4. **Customer Portal** aktivieren (Settings → Billing → Customer portal → Speichern),
   sonst schlägt „Abo verwalten" fehl.

## 2. Webhook einrichten
1. Developers → **Webhooks** → Endpoint hinzufügen:
   `https://roadlight.pro/api/stripe/webhook`
2. Events auswählen: `checkout.session.completed`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`.
3. Das **Signing Secret** (`whsec_…`) → `STRIPE_WEBHOOK_SECRET`.

## 3. Env-Vars setzen (roadlight-Projekt)
Lokal in `.env.local` (zum Testen) und in Vercel (Production):
```
STRIPE_SECRET_KEY=sk_test_…      (bzw. sk_live_… für Production)
STRIPE_WEBHOOK_SECRET=whsec_…
STRIPE_PRICE_PRO=price_…
```

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

## Endpoints (bereits gebaut)
- `POST /api/stripe/webhook` — Signatur-verifiziert, synct Abo-Status → `tenants` (nur Postgres).
- `GET  /api/admin/tenants/:slug/billing` — aktueller Plan/Status (Mitglieder).
- `POST /api/admin/tenants/:slug/billing/checkout` — Checkout-Session (Owner).
- `POST /api/admin/tenants/:slug/billing/portal` — Customer Portal (Owner).

## Gating (Pro-Features)
- **API & MCP:** hinter Pro gegatet — Erstellung *und* Nutzung von API-Schlüsseln.
  Aktiv erst mit `BILLING_ENFORCED=true` (+ Stripe + Postgres). Bis dahin offen.
- Beim Live-Schalten `BILLING_ENFORCED=true` setzen; Downgrade sperrt bestehende
  Keys mit `402` (Keys bleiben erhalten, Upgrade reaktiviert sie).

## Noch offen (Folge-PRs)
- **UI:** „Upgrade"/„Abo verwalten" in der Tenant-Konsole, Plan-Anzeige.
- **Gating:** weitere Free-Limits durchsetzen (1 Board, 2 Team-Mitglieder,
  „Powered by Roadlight"-Badge); Pro hebt sie auf.
