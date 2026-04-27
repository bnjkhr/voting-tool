const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicScript = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
const publicStyles = fs.readFileSync(path.join(__dirname, '../public/style.css'), 'utf8');

test('roadmap items open their matching public suggestion card', () => {
  assert.ok(
    publicScript.includes('openRoadmapItem(suggestionId)'),
    'expected a roadmap item opener'
  );
  assert.ok(
    publicScript.includes("onclick=\"app.openRoadmapItem('${item.id}')\""),
    'expected roadmap entries to call the opener'
  );
  assert.ok(
    publicScript.includes('id="suggestion-${suggestion.id}"'),
    'expected public suggestion cards to have stable anchors'
  );
  assert.ok(
    publicScript.includes("document.getElementById('roadmapView').classList.add('hidden')"),
    'expected roadmap clicks to hide the roadmap view before opening the suggestion'
  );
});

test('opened roadmap suggestions are visibly highlighted', () => {
  assert.ok(
    publicStyles.includes('.suggestion-card.is-highlighted'),
    'expected highlighted suggestion styling'
  );
});
