'use strict';

// Die Oberfläche bietet nur an, was der Server der angemeldeten Rolle erlaubt.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const read = (file) => fs.readFileSync(path.join(publicDir, file), 'utf8');

function loadTenantAdmin() {
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', classList: { toggle: () => {} } });
  const context = {
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      querySelectorAll: () => [],
    },
  };
  const source = read('tenant-admin.js')
    .replace('const tenantAdmin = new TenantAdminApp();', 'this.TenantAdminApp = TenantAdminApp;');
  vm.runInNewContext(source, context);

  const app = Object.create(context.TenantAdminApp.prototype);
  Object.assign(app, {
    session: null,
    isPlatformAdmin: false,
    escapeHtml: (value) => String(value ?? ''),
  });
  return { app, elements };
}

function inviteRolesFor({ app, elements }, role, isPlatformAdmin = false) {
  app.currentRole = role;
  app.isPlatformAdmin = isPlatformAdmin;
  app.renderSessionContext();
  const html = elements.get('teamInviteRole')?.innerHTML || '';
  return [...html.matchAll(/<option value="(\w+)"/g)].map((match) => match[1]);
}

test('Einladungsformular: Auswahl ist vor dem Laden der Session ohne Owner', () => {
  const select = read('tenant-admin.html').match(/<select[^>]*name="inviteRole"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(select, 'Rollenauswahl nicht gefunden');
  assert.ok(select[0].includes('id="teamInviteRole"'));
  assert.equal(select[1].includes('value="owner"'), false);
});

for (const [label, role, isPlatformAdmin, expected] of [
  ['Admin', 'admin', false, ['admin', 'viewer']],
  ['Viewer', 'viewer', false, ['admin', 'viewer']],
  ['Owner', 'owner', false, ['admin', 'owner', 'viewer']],
  ['Plattform-Admin', 'super_admin', true, ['admin', 'owner', 'viewer']],
]) {
  test(`Einladungsformular: ${label} sieht ${expected.join(', ')}`, () => {
    assert.deepEqual(inviteRolesFor(loadTenantAdmin(), role, isPlatformAdmin), expected);
  });
}

test('Einladungsformular: Auswahl folgt einer neu geladenen Rolle in beide Richtungen', () => {
  const loaded = loadTenantAdmin();

  assert.equal(inviteRolesFor(loaded, 'admin').includes('owner'), false);
  assert.equal(inviteRolesFor(loaded, 'owner').includes('owner'), true);
  assert.equal(inviteRolesFor(loaded, 'admin').includes('owner'), false);
});

for (const [viewer, inviteRole, canResend] of [
  ['admin', 'owner', false],
  ['admin', 'admin', true],
  ['owner', 'owner', true],
]) {
  test(`Offene Einladung (${inviteRole}) für ${viewer}: Erneut senden ${canResend ? 'sichtbar' : 'ausgeblendet'}`, () => {
    const { app } = loadTenantAdmin();
    app.currentRole = viewer;

    const html = app.renderTeamInvite({ id: 'i1', email: 'a@example.test', role: inviteRole });

    assert.equal(html.includes('data-action="resend-invite"'), canResend);
    // Widerrufen erlaubt der Server weiterhin auch Admins.
    assert.ok(html.includes('data-action="revoke-invite"'));
  });
}
