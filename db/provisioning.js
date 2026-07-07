'use strict';

// Atomare Multi-Entity-Writes für Auth/Onboarding (Signup + Invite-Annahme).
// Liegt in db/, weil im Rest der App sämtliches SQL (inkl. Transaktionen) hier
// gekapselt ist (vgl. suggestions.remove). Die User-Auflösung + Invarianten-
// Checks laufen INNERHALB der Transaktion (Zeilen-Lock via ON CONFLICT), damit
// konkurrierende Requests nicht in inkonsistente/doppelte Zustände laufen.
const crypto = require('crypto');
const { withTransaction } = require('./pool');

class WorkspaceExistsError extends Error {
  constructor() {
    super('A workspace already exists for this email');
    this.code = 'WORKSPACE_EXISTS';
  }
}

// Signup: Tenant + Board + (Owner-)User + Owner-Membership atomar anlegen.
// Wirft WorkspaceExistsError, wenn der User bereits ein aktives Membership hat
// (dann existiert schon ein Workspace). Tenant/Slug-Kollisionen schlagen über
// die PK/Unique-Constraints fehl (23505) und werden vom Aufrufer zu 409.
async function provisionWorkspace({
  tenantId, tenantName, tenantSlug,
  appId, appName, appDescription, appSlug, ticketPrefix,
  email, membershipId,
}) {
  return withTransaction(async (client) => {
    await client.query(
      `insert into tenants (id, name, display_name, slug, status)
       values ($1, $2, $3, $4, 'active')`,
      [tenantId, tenantName, tenantName, tenantSlug]
    );
    await client.query(
      `insert into apps (id, tenant_id, name, description, slug, ticket_prefix, labels)
       values ($1, $2, $3, $4, $5, $6, '{}')`,
      [appId, tenantId, appName, appDescription, appSlug, ticketPrefix]
    );
    // Upsert User by email (lockt die Zeile). Neuer User -> display_name = email.
    const u = await client.query(
      `insert into users (id, email, display_name) values ($1, $2, $3)
       on conflict (email) do update set status = 'active', updated_at = now()
       returning id`,
      [crypto.randomUUID(), email, email]
    );
    const userId = u.rows[0].id;
    // Invariante innerhalb der Transaktion: kein bestehendes aktives Membership.
    const existing = await client.query(
      `select 1 from memberships where user_id = $1 and status = 'active' limit 1`,
      [userId]
    );
    if (existing.rowCount > 0) throw new WorkspaceExistsError();
    await client.query(
      `insert into memberships (id, tenant_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [membershipId, tenantId, userId]
    );
    return { userId, membershipId };
  });
}

// Invite-Annahme: User + Membership + Invite-Status atomar. Reaktiviert einen
// ggf. deaktivierten User (sonst schlüge die Session sofort in resolveSessionAuth
// fehl). Gibt die tatsächlichen ids zurück.
async function acceptInvite({ tenantId, inviteId, email, displayName, role }) {
  const dn = (displayName || '').trim();
  return withTransaction(async (client) => {
    const u = await client.query(
      `insert into users (id, email, display_name) values ($1, $2, $3)
       on conflict (email) do update
         set status = 'active',
             display_name = case
               when (users.display_name is null or users.display_name = '') and $4 <> ''
               then $4 else users.display_name end,
             updated_at = now()
       returning id`,
      [crypto.randomUUID(), email, dn || email, dn]
    );
    const userId = u.rows[0].id;
    const m = await client.query(
      `insert into memberships (id, tenant_id, user_id, role) values ($1, $2, $3, $4)
       on conflict (tenant_id, user_id) do update
         set role = excluded.role, status = 'active', updated_at = now()
       returning id`,
      [crypto.randomUUID(), tenantId, userId, role]
    );
    const membershipId = m.rows[0].id;
    await client.query(
      `update invites set status = 'accepted', accepted_at = now(), updated_at = now() where id = $1`,
      [inviteId]
    );
    return { userId, membershipId };
  });
}

module.exports = { provisionWorkspace, acceptInvite, WorkspaceExistsError };
