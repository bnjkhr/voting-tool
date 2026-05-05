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
    publicScript.includes('data-action="open-roadmap-item"'),
    'expected roadmap entries to declare the open-roadmap-item action'
  );
  assert.ok(
    publicScript.includes('data-item-id="${this.escapeHtml(item.id)}"'),
    'expected roadmap entries to carry the item id as a data attribute'
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

test('public/script.js does not emit inline event-handler attributes', () => {
  // Any inline event-handler attribute (onclick, onchange, onerror, onload,
  // onmouseover, onpointerdown, ondragstart, onbeforeunload, ...) re-opens
  // the HTML/JS injection surface that the click/change delegation refactor
  // was meant to close. Match the *attribute* form specifically — `=` followed
  // by a quote — so that legitimate JS property assignments inside this same
  // file (e.g. `reader.onload = ...`) do not trigger a false positive.
  const inlineHandler = /\bon[a-z]+\s*=\s*["']/i;
  const match = publicScript.match(inlineHandler);
  assert.equal(
    match,
    null,
    `expected no inline on*= handlers in public/script.js — use data-action / data-change-action delegation instead. Found: ${match?.[0]}`
  );
});
