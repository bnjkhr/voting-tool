const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adminHtml = fs.readFileSync(path.join(__dirname, '../public/admin.html'), 'utf8');

function countOccurrences(source, needle) {
  return source.split(needle).length - 1;
}

test('admin layout keeps planning controls in the left column', () => {
  const sidebarIndex = adminHtml.indexOf('class="admin-sidebar"');
  const mainIndex = adminHtml.indexOf('class="admin-main"');
  const releaseIndex = adminHtml.indexOf('id="releasesList"');
  const filterIndex = adminHtml.indexOf('class="filter-panel"');
  const suggestionsIndex = adminHtml.indexOf('id="suggestionsList"');

  assert.ok(sidebarIndex > -1, 'expected an admin sidebar');
  assert.ok(mainIndex > -1, 'expected an admin main column');
  assert.ok(releaseIndex > sidebarIndex, 'expected releases in the sidebar');
  assert.ok(filterIndex > releaseIndex, 'expected filters below releases');
  assert.ok(mainIndex > filterIndex, 'expected main column after sidebar controls');
  assert.ok(suggestionsIndex > mainIndex, 'expected suggestions in the main column');
});

test('admin filters are rendered once', () => {
  ['appFilter', 'typeFilter', 'statusFilter', 'priorityFilter'].forEach(id => {
    assert.equal(countOccurrences(adminHtml, `id="${id}"`), 1, `expected one #${id}`);
  });
});

test('admin page can use a wider container than the public frontend', () => {
  assert.ok(adminHtml.includes('body > .container'));
  assert.ok(adminHtml.includes('max-width: 1440px'));
});

test('legacy admin page points users to the SaaS admin surfaces', () => {
  assert.ok(adminHtml.includes('Legacy Admin Dashboard'));
  assert.ok(adminHtml.includes('id="legacyAdminNotice"'));
  assert.ok(adminHtml.includes('href="/super-admin.html"'));
  assert.ok(adminHtml.includes('href="/signup.html"'));
  assert.ok(adminHtml.includes('href="/login.html"'));
  assert.ok(adminHtml.includes('Legacy-Live-Betrieb'));
  assert.ok(adminHtml.includes('SaaS / Friendly User-Test'));
});

test('admin shows the to-do stack before the management sections and collapses them', () => {
  const stackIndex = adminHtml.indexOf('id="todoStack"');
  assert.ok(stackIndex > -1, 'expected a to-do stack');
  assert.ok(stackIndex < adminHtml.indexOf('class="app-management"'), 'stack must come first');
  assert.equal(countOccurrences(adminHtml, '<details class="management-section"'), 3);
});

test('tenant admin shows the to-do stack above a collapsible filter', () => {
  const tenantHtml = fs.readFileSync(path.join(__dirname, '../public/tenant-admin.html'), 'utf8');
  const stackIndex = tenantHtml.indexOf('id="todoStack"');
  assert.ok(stackIndex > -1 && stackIndex < tenantHtml.indexOf('id="filterPanel"'));
  assert.ok(tenantHtml.includes('<details class="tenant-admin-panel tenant-collapsible" id="filterPanel">'));
});
