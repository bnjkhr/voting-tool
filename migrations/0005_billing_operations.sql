-- Robuste Stripe-Operationen fuer den Pro-Launch.
--
-- billing_checkout_sessions serialisiert Checkout-Erstellung pro Tenant und
-- speichert die fuer Verbraucher erforderlichen Zustimmungen nachvollziehbar.
-- stripe_webhook_events verhindert doppelte Verarbeitung bei Stripe-Retries.

create table billing_checkout_sessions (
  tenant_id                         text primary key references tenants(id) on delete cascade,
  attempt_id                       text unique not null,
  stripe_session_id                text unique,
  checkout_url                     text,
  status                           text not null default 'creating'
                                     check (status in ('creating','ready','completed','failed','expired')),
  terms_version                    text not null,
  terms_accepted_at                timestamptz not null,
  immediate_performance_accepted_at timestamptz not null,
  accepted_by                      text,
  expires_at                       timestamptz not null,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now()
);

create index billing_checkout_expiry_idx
  on billing_checkout_sessions (expires_at);

create table stripe_webhook_events (
  event_id      text primary key,
  event_type    text not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz
);
