'use strict';

// Atomare Workspace-Provisionierung (Signup): Tenant + Board + User +
// Owner-Membership in EINER Transaktion. Liegt hier statt im Endpoint, weil im
// Rest der App sämtliches SQL (inkl. Transaktionen) in db/*.js gekapselt ist
// (vgl. suggestions.remove). Ein Teilerfolg würde sonst einen verwaisten Tenant
// hinterlassen und Re-Signup blockieren.
const { withTransaction } = require('./pool');

async function provisionWorkspace({
  tenantId, tenantName, tenantSlug,
  appId, appName, appDescription, appSlug, ticketPrefix,
  userId, email, userExists, membershipId,
}) {
  await withTransaction(async (client) => {
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
    if (userExists) {
      await client.query(`update users set status = 'active', updated_at = now() where id = $1`, [userId]);
    } else {
      await client.query(`insert into users (id, email, display_name) values ($1, $2, $3)`, [userId, email, email]);
    }
    await client.query(
      `insert into memberships (id, tenant_id, user_id, role) values ($1, $2, $3, 'owner')`,
      [membershipId, tenantId, userId]
    );
  });
}

module.exports = { provisionWorkspace };
