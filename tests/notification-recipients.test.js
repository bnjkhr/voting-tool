const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const apiSource = fs.readFileSync(path.join(__dirname, '..', 'api/index.js'), 'utf8');

test('admin notification emails are no longer hardcoded to a private operator address', () => {
  // Vor dem Fix landeten alle Tenant-Benachrichtigungen bei 'ben.kohler@me.com' (Cross-Tenant-Leak).
  assert.equal(
    apiSource.includes("to: 'ben.kohler@me.com'"),
    false,
    'admin notification recipients must not be hardcoded in resend.emails.send'
  );
});

test('every admin notification call site resolves recipients dynamically', () => {
  const suggestionCalls = apiSource.match(/sendAdminNotificationEmail\(/g) || [];
  const commentCalls = apiSource.match(/sendAdminCommentNotificationEmail\(/g) || [];
  // Je eine Definition + tatsächliche Aufrufe.
  assert.ok(suggestionCalls.length >= 3, 'expected suggestion notification call sites');
  assert.ok(commentCalls.length >= 3, 'expected comment notification call sites');

  // Jeder Aufruf muss vorab resolveNotificationRecipients verwenden.
  const resolveUses = apiSource.match(/resolveNotificationRecipients\(/g) || [];
  // 1 Definition + je ein Aufruf pro Notification-Call-Site (4 Stellen).
  assert.ok(resolveUses.length >= 5, 'expected recipients to be resolved before every notification');
});

test('notification recipients are scoped to the tenant, legacy data goes to the operator only', () => {
  const fnStart = apiSource.indexOf('async function resolveNotificationRecipients');
  assert.ok(fnStart !== -1, 'resolveNotificationRecipients must exist');
  const fnBody = apiSource.slice(fnStart, apiSource.indexOf('\n}\n', fnStart));

  // Legacy/leerer Tenant -> Betreiber-Adresse.
  assert.ok(fnBody.includes('LEGACY_TENANT_ID'), 'legacy tenants must route to the operator');
  assert.ok(fnBody.includes('OPERATOR_EMAIL'), 'operator fallback must be used for legacy data');
  // Reale Tenants -> nur aktive Owner/Admins, tenant-scoped Query.
  assert.ok(fnBody.includes("collection('memberships')"), 'tenant recipients come from memberships');
  assert.ok(fnBody.includes("where('tenantId', '==', tenantId)"), 'membership query must be tenant-scoped');
  assert.ok(fnBody.includes("'owner'") && fnBody.includes("'admin'"), 'only owners/admins are notified');
  assert.ok(fnBody.includes("=== 'active'") || fnBody.includes("'active'"), 'only active members are notified');
});

test('operator address is configurable via env instead of hardcoded', () => {
  assert.ok(
    apiSource.includes("const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL"),
    'operator email must be configurable through OPERATOR_EMAIL'
  );
});

test('admin password comparison is constant-time to prevent timing attacks', () => {
  assert.equal(
    /return token === adminPassword/.test(apiSource),
    false,
    'admin password must not be compared with a non-constant-time === check'
  );
  assert.ok(apiSource.includes('crypto.timingSafeEqual'), 'expected timingSafeEqual for secret comparison');
  assert.ok(apiSource.includes('safeCompareSecret(token, adminPassword)'), 'hasValidAdminPassword must use the safe comparator');
});
