-- Roadlight wird vor dem Premium-Gating auf B2B-only umgestellt.
-- Neue Registrierungen und Checkout-Versuche protokollieren die ausdrueckliche
-- Unternehmerbestaetigung. Bestehende Zeilen bleiben nullable, damit die
-- additive Migration den laufenden Betrieb nicht blockiert.

alter table tenants
  add column if not exists business_customer_confirmed_at timestamptz,
  add column if not exists business_customer_confirmed_by text;

alter table billing_checkout_sessions
  add column if not exists business_customer_confirmed_at timestamptz;

alter table billing_checkout_sessions
  alter column immediate_performance_accepted_at drop not null;
