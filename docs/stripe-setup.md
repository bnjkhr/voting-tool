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

## 4. Lokal testen (Stripe CLI)
```
stripe login
stripe listen --forward-to localhost:3000/api/stripe/webhook   # liefert ein whsec_ für lokal
# in einem Board als Owner: "Upgrade" -> Checkout mit Test-Karte 4242 4242 4242 4242
stripe trigger checkout.session.completed                       # optional: Event manuell
```
Nach erfolgreichem Checkout sollte in Neon `tenants.plan = 'pro'`,
`subscription_status = 'active'`, `stripe_customer_id`/`current_period_end`
gesetzt sein.

## Endpoints (bereits gebaut)
- `POST /api/stripe/webhook` — Signatur-verifiziert, synct Abo-Status → `tenants` (nur Postgres).
- `GET  /api/admin/tenants/:slug/billing` — aktueller Plan/Status (Mitglieder).
- `POST /api/admin/tenants/:slug/billing/checkout` — Checkout-Session (Owner).
- `POST /api/admin/tenants/:slug/billing/portal` — Customer Portal (Owner).

## Noch offen (Folge-PRs)
- **UI:** „Upgrade"/„Abo verwalten" in der Tenant-Konsole, Plan-Anzeige.
- **Gating:** Free-Limits durchsetzen (1 Board, 2 Team-Mitglieder,
  „Powered by Roadlight"-Badge); Pro hebt sie auf.
