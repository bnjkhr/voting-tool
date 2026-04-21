const test = require('node:test');
const assert = require('node:assert/strict');

const {
  compareAdminSuggestions,
  getAdminSuggestionSortBucket,
} = require('../api/admin-suggestion-sort');

test('admin sorting prioritizes open suggestion approvals first', () => {
  const pendingSuggestion = {
    id: 'pending-suggestion',
    approved: false,
    pendingCommentCount: 0,
    status: 'neu',
    votes: 0,
    createdAt: new Date('2026-04-20T10:00:00Z'),
  };
  const pendingComment = {
    id: 'pending-comment',
    approved: true,
    pendingCommentCount: 2,
    status: 'offen',
    votes: 5,
    createdAt: new Date('2026-04-20T12:00:00Z'),
  };
  const normalApproved = {
    id: 'normal-approved',
    approved: true,
    pendingCommentCount: 0,
    status: 'offen',
    votes: 10,
    createdAt: new Date('2026-04-20T14:00:00Z'),
  };

  const sorted = [normalApproved, pendingComment, pendingSuggestion].sort(compareAdminSuggestions);
  assert.deepEqual(sorted.map(item => item.id), [
    'pending-suggestion',
    'pending-comment',
    'normal-approved',
  ]);
});

test('admin sorting keeps resolved entries below unresolved ones within the same bucket', () => {
  const unresolved = {
    id: 'unresolved',
    approved: true,
    pendingCommentCount: 0,
    status: 'offen',
    votes: 0,
    createdAt: new Date('2026-04-20T10:00:00Z'),
  };
  const resolved = {
    id: 'resolved',
    approved: true,
    pendingCommentCount: 0,
    status: 'geschlossen',
    votes: 100,
    createdAt: new Date('2026-04-20T12:00:00Z'),
  };

  const sorted = [resolved, unresolved].sort(compareAdminSuggestions);
  assert.deepEqual(sorted.map(item => item.id), ['unresolved', 'resolved']);
});

test('admin sort bucket separates open approvals from normal entries', () => {
  assert.equal(getAdminSuggestionSortBucket({ approved: false, pendingCommentCount: 0 }), 0);
  assert.equal(getAdminSuggestionSortBucket({ approved: true, pendingCommentCount: 3 }), 1);
  assert.equal(getAdminSuggestionSortBucket({ approved: true, pendingCommentCount: 0 }), 2);
});
