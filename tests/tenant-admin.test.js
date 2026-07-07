const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const tenantAdminHtml = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.html'), 'utf8');
const tenantAdminScript = fs.readFileSync(path.join(rootDir, 'public/tenant-admin.js'), 'utf8');

test('tenant admin html loads the tenant admin script', () => {
  assert.ok(
    tenantAdminHtml.includes('src="tenant-admin.js"'),
    'expected tenant-admin.html to load tenant-admin.js'
  );
});

test('tenant admin uses shared admin auth as transition auth', () => {
  assert.ok(
    tenantAdminHtml.includes('src="admin-auth.js"'),
    'expected tenant admin to load shared admin auth'
  );

  assert.ok(
    tenantAdminScript.includes('window.adminAuth.authFetch'),
    'expected tenant admin API calls to use shared bearer authorization'
  );
});

test('tenant admin api routes are tenant scoped', () => {
  [
    "app.get('/api/admin/tenants/:tenantSlug/apps'",
    "app.get('/api/admin/tenants/:tenantSlug/stats'",
    "app.get('/api/admin/tenants/:tenantSlug/members'",
    "app.post('/api/admin/tenants/:tenantSlug/invites'",
    "app.get('/api/admin/tenants/:tenantSlug/suggestions'",
    "app.post('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/approve'",
    "app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/status'",
    "app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/priority'",
    "app.get('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/comments'",
    "app.post('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/comments'",
    "app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/comments/:commentId/approve'",
    "app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/comments/:commentId/reject'",
  ].forEach(route => {
    assert.ok(apiSource.includes(route), `expected ${route}`);
  });
});

test('tenant admin api resolves documents through tenant scope', () => {
  assert.ok(
    apiSource.includes('resolveAdminTenantFromParam'),
    'expected tenant admin routes to resolve the tenant from the slug'
  );

  assert.ok(
    apiSource.includes('resolveTenantSuggestionById'),
    'expected tenant admin suggestion actions to resolve suggestions through tenant scope'
  );
});

test('tenant admin exposes a team invite panel', () => {
  assert.ok(tenantAdminHtml.includes('id="teamMembersList"'));
  assert.ok(tenantAdminHtml.includes('id="teamInvitesList"'));
  assert.ok(tenantAdminHtml.includes('id="teamInviteForm"'));
  assert.ok(tenantAdminHtml.includes('name="inviteEmail"'));
  assert.ok(tenantAdminHtml.includes('name="inviteRole"'));
  assert.ok(tenantAdminScript.includes('loadTeam'));
  assert.ok(tenantAdminScript.includes('sendInvite'));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath('/members')"));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath('/invites')"));
});

test('tenant admin exposes team member and invite management', () => {
  [
    "app.put('/api/admin/tenants/:tenantSlug/members/:membershipId'",
    "app.delete('/api/admin/tenants/:tenantSlug/members/:membershipId'",
    "app.post('/api/admin/tenants/:tenantSlug/invites/:inviteId/resend'",
    "app.delete('/api/admin/tenants/:tenantSlug/invites/:inviteId'",
  ].forEach(route => {
    assert.ok(apiSource.includes(route), `expected ${route}`);
  });

  assert.ok(apiSource.includes('assertTenantMemberMutationAllowed'));
  assert.ok(apiSource.includes('countActiveTenantOwners'));
  assert.ok(apiSource.includes('Cannot remove the last active owner'));

  assert.ok(tenantAdminScript.includes('updateMemberRole'));
  assert.ok(tenantAdminScript.includes('disableMember'));
  assert.ok(tenantAdminScript.includes('revokeInvite'));
  assert.ok(tenantAdminScript.includes('resendInvite'));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath(`/members/${encodeURIComponent(memberId)}`)"));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath(`/invites/${encodeURIComponent(inviteId)}`)"));
  assert.ok(tenantAdminHtml.includes('tenant-team-actions'));
});

test('tenant admin exposes workspace settings with tenant scoped api routes', () => {
  assert.ok(apiSource.includes("app.get('/api/admin/tenants/:tenantSlug/settings'"));
  assert.ok(apiSource.includes("app.put('/api/admin/tenants/:tenantSlug/settings'"));
  assert.ok(apiSource.includes('buildTenantSettingsResponse'));
  assert.ok(apiSource.includes('buildTenantSettingsUpdate'));

  [
    'id="workspaceSettingsForm"',
    'name="workspaceName"',
    'name="workspaceSlug"',
    'name="boardName"',
    'name="ticketPrefix"',
    'name="emailFromName"',
    'name="replyToEmail"',
  ].forEach(fragment => {
    assert.ok(tenantAdminHtml.includes(fragment), `expected ${fragment}`);
  });

  assert.ok(tenantAdminScript.includes('loadSettings'));
  assert.ok(tenantAdminScript.includes('saveSettings'));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath('/settings')"));
  assert.ok(tenantAdminScript.includes('workspaceSettingsReadonly'));
});

test('tenant admins can create tenant scoped boards for friendly users', () => {
  assert.ok(apiSource.includes("app.post('/api/admin/tenants/:tenantSlug/apps'"));
  assert.ok(apiSource.includes("db.collection('counters').doc(appRef.id)"));
  assert.ok(apiSource.includes('Tenant app slug already exists'));

  [
    'id="tenantBoardForm"',
    'id="tenantBoardsList"',
    'name="boardName"',
    'name="boardSlug"',
    'name="boardTicketPrefix"',
  ].forEach(fragment => {
    assert.ok(tenantAdminHtml.includes(fragment), `expected ${fragment}`);
  });

  assert.ok(tenantAdminScript.includes('createBoard'));
  assert.ok(tenantAdminScript.includes('renderBoards'));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath('/apps')"));
  assert.ok(tenantAdminScript.includes('boardTicketPrefix'));
});

test('tenant invites are delivered by email without exposing raw accept links in the ui', () => {
  assert.ok(apiSource.includes('sendTenantInviteEmail'));
  assert.equal(apiSource.includes('acceptUrl: accept'), false);
  assert.ok(apiSource.includes("delivery: 'email'"));
  assert.equal(tenantAdminScript.includes('result.acceptUrl'), false);
  assert.equal(tenantAdminScript.includes('Einladungslink:'), false);
  assert.ok(tenantAdminScript.includes('Einladung per E-Mail verschickt'));
});

test('tenant admin renders the workspace console shell with role context', () => {
  assert.ok(tenantAdminHtml.includes('workspace-admin-shell'));
  assert.ok(tenantAdminHtml.includes('id="userIdentity"'));
  assert.ok(tenantAdminHtml.includes('id="roleContext"'));
  assert.ok(tenantAdminHtml.includes('id="platformAdminLink"'));
  assert.ok(tenantAdminHtml.includes('data-admin-only'));
  assert.ok(tenantAdminScript.includes('loadSession'));
  assert.ok(tenantAdminScript.includes('/api/auth/session'));
  assert.ok(tenantAdminScript.includes('canManageWorkspace'));
});

test('tenant-admin.js does not emit inline event-handler attributes', () => {
  // Inline on*= handlers re-open the HTML/JS injection surface that the
  // click/change delegation refactor was meant to close (CSP-driven). Match
  // the *attribute* form specifically — `=` followed by a quote — so that
  // legitimate JS property assignments would not trigger a false positive.
  const inlineHandler = /\bon[a-z]+\s*=\s*["']/i;
  const match = tenantAdminScript.match(inlineHandler);
  assert.equal(
    match,
    null,
    `expected no inline on*= handlers in public/tenant-admin.js — use data-action / data-change-action delegation instead. Found: ${match?.[0]}`
  );
});

test('tenant admin wires suggestion and team actions through delegation', () => {
  [
    "data-change-action=\"update-status\"",
    "data-change-action=\"update-priority\"",
    "data-action=\"approve-suggestion\"",
    "data-action=\"toggle-comments\"",
    "data-action=\"add-comment\"",
    "data-action=\"moderate-comment\"",
    "data-change-action=\"update-member-role\"",
    "data-action=\"enable-member\"",
    "data-action=\"disable-member\"",
    "data-action=\"resend-invite\"",
    "data-action=\"revoke-invite\"",
  ].forEach(fragment => {
    assert.ok(tenantAdminScript.includes(fragment), `expected ${fragment}`);
  });
});

test('tenant admin exposes a billing panel wired to the tenant-scoped billing endpoints', () => {
  // Panel + Mount-Punkt im Settings-Tab.
  assert.ok(tenantAdminHtml.includes('id="billingPanel"'));
  assert.ok(tenantAdminHtml.includes('id="billingStatus"'));

  // Laden + Rendern.
  assert.ok(tenantAdminScript.includes('loadBilling'));
  assert.ok(tenantAdminScript.includes('renderBilling'));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath('/billing')"));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath('/billing/checkout')"));
  assert.ok(tenantAdminScript.includes("this.tenantAdminPath('/billing/portal')"));

  // Delegation der Buttons.
  assert.ok(tenantAdminScript.includes('data-action="billing-upgrade"'));
  assert.ok(tenantAdminScript.includes('data-action="billing-portal"'));

  // Aktionen sind Owner-only (Endpoints verlangen Owner-Mitgliedschaft).
  assert.ok(tenantAdminScript.includes("this.currentRole !== 'owner'"),
    'expected checkout/portal actions to be gated on owner role');

  // Upgrade nur bei voller Checkout-Bereitschaft (Key UND Preis), sonst 503.
  assert.ok(apiSource.includes('checkoutReady'), 'billing GET exposes checkoutReady');
  assert.ok(apiSource.includes('STRIPE_PRICE_PRO'), 'checkoutReady prueft den Preis');
  assert.ok(tenantAdminScript.includes('b.checkoutReady'),
    'expected the upgrade button to be gated on checkoutReady');

  // Checkout-Rückkehr wird einmalig ausgewertet und aus der URL entfernt.
  assert.ok(tenantAdminScript.includes("params.get('billing')"));
  assert.ok(tenantAdminScript.includes("this.billingReturn === 'success'"));
});

test('tenant admin shows dismissible onboarding for signup redirects', () => {
  assert.ok(tenantAdminHtml.includes('id="workspaceOnboarding"'));
  assert.ok(tenantAdminHtml.includes('id="dismissOnboardingBtn"'));
  assert.ok(tenantAdminHtml.includes('Workspace erstellt'));
  assert.ok(tenantAdminHtml.includes('Teammitglied einladen'));
  assert.ok(tenantAdminScript.includes('shouldShowOnboarding'));
  assert.ok(tenantAdminScript.includes('renderOnboarding'));
  assert.ok(tenantAdminScript.includes('dismissOnboarding'));
  assert.ok(tenantAdminScript.includes("params.get('onboarding') === '1'"));
  assert.ok(tenantAdminScript.includes('localStorage'));
  assert.ok(tenantAdminScript.includes('tenantAdmin:onboardingDismissed:'));
});
