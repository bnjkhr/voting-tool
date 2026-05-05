const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');

test('signup page lets a new owner create a workspace', () => {
  const html = fs.readFileSync(path.join(rootDir, 'public/signup.html'), 'utf8');
  const script = fs.readFileSync(path.join(rootDir, 'public/signup.js'), 'utf8');

  assert.ok(html.includes('id="signupForm"'));
  assert.ok(html.includes('name="email"'));
  assert.ok(html.includes('name="workspaceName"'));
  assert.ok(html.includes('name="workspaceSlug"'));
  assert.ok(html.includes('name="boardName"'));
  assert.ok(html.includes('name="ticketPrefix"'));
  assert.ok(html.includes('href="/login.html"'));
  assert.ok(html.includes('src="signup.js"'));

  assert.ok(script.includes("fetch('/api/signup/workspaces'"));
  assert.ok(script.includes("method: 'POST'"));
  assert.ok(script.includes('syncWorkspaceSlug'));
  assert.ok(script.includes('slugTouched'));
  assert.ok(script.includes('normalizeSlug'));
  assert.equal(script.includes('data.loginUrl'), false);
  assert.ok(script.includes('Login-Link wurde per E-Mail verschickt.'));
});

test('signup api provisions tenant, owner membership and login link without admin auth', () => {
  assert.ok(apiSource.includes("app.post('/api/signup/workspaces'"));
  assert.ok(apiSource.includes('buildSignupWorkspaceConfig'));
  assert.ok(apiSource.includes('buildTenantProvisionDocuments'));
  assert.ok(apiSource.includes('buildUserData'));
  assert.ok(apiSource.includes('buildMembershipData'));
  assert.ok(apiSource.includes("role: 'owner'"));
  assert.ok(apiSource.includes('buildLoginLinkData'));
  assert.ok(apiSource.includes('redirectUrl'));
  assert.ok(apiSource.includes('onboarding=1'));
  assert.ok(apiSource.includes('sendLoginLinkEmail'));
  assert.ok(apiSource.includes("delivery: 'email'"));
  assert.equal(apiSource.includes('signupLoginUrl,'), false);
});
