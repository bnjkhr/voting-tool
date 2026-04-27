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
