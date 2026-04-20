const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const publicScript = fs.readFileSync(path.join(rootDir, 'public', 'script.js'), 'utf8');
const publicStyles = fs.readFileSync(path.join(rootDir, 'public', 'style.css'), 'utf8');

test('suggestions with comments render their comment section visible by default', () => {
  assert.ok(
    publicScript.includes("class=\"comments-section ${hasComments ? 'is-visible' : ''}\""),
    'expected suggestion cards with comments to render an open comments section'
  );

  assert.ok(
    publicScript.includes('.filter(suggestion => suggestion.commentCount > 0)'),
    'expected the app to eagerly load comments for suggestions that already have comments'
  );
});

test('comments section has a dedicated visible state in CSS', () => {
  assert.ok(
    publicStyles.includes('.comments-section.is-visible'),
    'expected a CSS modifier that shows visible comments sections'
  );
});
