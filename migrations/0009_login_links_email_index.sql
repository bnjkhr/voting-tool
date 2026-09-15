-- Neon-Migration 0009: Index für das Login-Link-Limit pro E-Mail-Adresse.
-- Signup und Login-Link-Anforderung zählen vor dem Mailversand die jüngsten
-- login_links derselben Adresse (lib/bot-protection.js).
create index if not exists login_links_email_created_idx
  on login_links (email, created_at);
