const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');

test('invite acceptance page loads the acceptance script and required form fields', () => {
  const html = fs.readFileSync(path.join(rootDir, 'public/accept-invite.html'), 'utf8');

  assert.ok(html.includes('src="accept-invite.js"'));
  assert.ok(html.includes('id="acceptInviteForm"'));
  assert.ok(html.includes('name="displayName"'));
  assert.ok(html.includes('id="inviteSummary"'));
});

test('invite acceptance script verifies and accepts invite tokens', () => {
  const script = fs.readFileSync(path.join(rootDir, 'public/accept-invite.js'), 'utf8');

  assert.ok(script.includes("fetch(`/api/invites/${encodeURIComponent(this.token)}`"));
  assert.ok(script.includes("fetch(`/api/invites/${encodeURIComponent(this.token)}/accept`"));
  assert.ok(script.includes("method: 'POST'"));
  assert.ok(script.includes('window.adminAuth.setUserSession'));
});

test('public invite routes are exposed without admin auth', () => {
  assert.ok(apiSource.includes("app.get('/api/invites/:token'"));
  assert.ok(apiSource.includes("app.post('/api/invites/:token/accept'"));
  assert.ok(apiSource.includes('resolvePendingInviteByToken'));
  assert.ok(apiSource.includes('buildMembershipData'));
  assert.ok(apiSource.includes('buildUserData'));
  assert.ok(apiSource.includes('buildSessionData'));
  assert.ok(apiSource.includes('sessionToken'));
});
