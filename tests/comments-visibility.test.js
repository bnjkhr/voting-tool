const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const publicScript = fs.readFileSync(path.join(rootDir, 'public', 'script.js'), 'utf8');
const adminScript = fs.readFileSync(path.join(rootDir, 'public', 'admin.js'), 'utf8');
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

test('approved entries support a public comment composer with moderated submission flow', () => {
  assert.ok(
    publicScript.includes('renderTicketCommentComposer(suggestionId)'),
    'expected the public app to render a dedicated ticket comment composer'
  );

  assert.ok(
    publicScript.includes("['feature', 'bug', 'ticket'].includes(suggestionType)"),
    'expected the public comment composer to be available for bugs, tickets, and features'
  );

  assert.ok(
    publicScript.includes("fetch(`/api/suggestions/${suggestionId}/comments`"),
    'expected public comments to be submitted through the public comments endpoint'
  );

  assert.ok(
    publicScript.includes('Kommentar eingereicht. Er wird nach Freigabe sichtbar.'),
    'expected users to see that comments wait for admin approval'
  );
});

test('comments section has a dedicated visible state in CSS', () => {
  assert.ok(
    publicStyles.includes('.comments-section.is-visible'),
    'expected a CSS modifier that shows visible comments sections'
  );

  assert.ok(
    publicStyles.includes('.comment-composer'),
    'expected the public comment composer to have dedicated styling'
  );
});

test('admin UI exposes moderation actions for user comments', () => {
  assert.ok(
    adminScript.includes('approveComment(suggestionId, commentId)'),
    'expected admin UI to support approving pending comments'
  );

  assert.ok(
    adminScript.includes('rejectComment(suggestionId, commentId)'),
    'expected admin UI to support rejecting pending comments'
  );

  assert.ok(
    adminScript.includes('pendingCommentCount'),
    'expected admin UI to surface pending comment counts'
  );

  assert.ok(
    adminScript.includes(".filter(suggestion => suggestion.pendingCommentCount > 0)"),
    'expected admin UI to eagerly load pending comments for moderation'
  );
});
