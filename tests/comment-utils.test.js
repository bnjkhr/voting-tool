const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAdminCommentResponse,
  buildCommentStats,
  buildPublicCommentResponse,
  isCommentVisibleToPublic,
  normalizeCommentData,
  validateCommentScreenshots,
} = require('../api/comment-utils');

test('legacy admin comments are treated as approved and public', () => {
  const legacyComment = normalizeCommentData({
    text: 'Legacy admin comment',
    screenshots: [],
    createdAt: new Date(),
  });

  assert.equal(legacyComment.authorType, 'admin');
  assert.equal(legacyComment.approvalStatus, 'approved');
  assert.equal(isCommentVisibleToPublic(legacyComment), true);
});

test('user comments default to pending until moderated', () => {
  const userComment = normalizeCommentData({
    text: 'Need help with this ticket',
    authorFingerprint: 'fingerprint-123',
    createdAt: new Date(),
  });

  assert.equal(userComment.authorType, 'user');
  assert.equal(userComment.approvalStatus, 'pending');
  assert.equal(isCommentVisibleToPublic(userComment), false);
});

test('public comment response excludes pending comments', () => {
  const pendingDoc = {
    id: 'pending-1',
    data: () => ({
      text: 'Pending user comment',
      authorType: 'user',
      approvalStatus: 'pending',
      createdAt: new Date(),
    }),
  };

  const approvedDoc = {
    id: 'approved-1',
    data: () => ({
      text: 'Approved user comment',
      authorType: 'user',
      approvalStatus: 'approved',
      screenshots: ['data:image/jpeg;base64,abc'],
      createdAt: new Date(),
    }),
  };

  assert.equal(buildPublicCommentResponse(pendingDoc), null);
  assert.deepEqual(buildPublicCommentResponse(approvedDoc), {
    id: 'approved-1',
    text: 'Approved user comment',
    screenshots: ['data:image/jpeg;base64,abc'],
    createdAt: approvedDoc.data().createdAt,
    authorType: 'user',
  });
});

test('admin comment response keeps moderation metadata for review', () => {
  const doc = {
    id: 'comment-1',
    data: () => ({
      text: 'Needs approval',
      authorType: 'user',
      approvalStatus: 'pending',
      approvedAt: null,
      rejectedAt: null,
      createdAt: new Date(),
    }),
  };

  const result = buildAdminCommentResponse(doc);
  assert.equal(result.id, 'comment-1');
  assert.equal(result.authorType, 'user');
  assert.equal(result.approvalStatus, 'pending');
});

test('comment stats count public and pending comments separately', () => {
  const commentDocs = [
    {
      data: () => ({ text: 'Admin', authorType: 'admin', createdAt: new Date() }),
    },
    {
      data: () => ({ text: 'Pending', authorType: 'user', approvalStatus: 'pending', createdAt: new Date() }),
    },
    {
      data: () => ({ text: 'Approved user', authorType: 'user', approvalStatus: 'approved', createdAt: new Date() }),
    },
  ];

  assert.deepEqual(buildCommentStats(commentDocs), {
    totalCount: 3,
    pendingCount: 1,
    publicCount: 2,
  });
});

test('comment screenshot validation enforces count and total size limits', () => {
  const validScreenshots = [
    'data:image/jpeg;base64,abc',
    'data:image/png;base64,def',
  ];

  assert.deepEqual(validateCommentScreenshots(validScreenshots), {
    screenshots: validScreenshots,
  });

  assert.deepEqual(
    validateCommentScreenshots(new Array(6).fill('data:image/jpeg;base64,abc')),
    { error: 'Maximum 5 screenshots allowed' }
  );

  assert.deepEqual(
    validateCommentScreenshots(['not-an-image']),
    { screenshots: [] }
  );
});

test('public comment endpoint is no longer restricted to tickets', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const apiIndex = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');

  assert.ok(
    !apiIndex.includes('Comments from users are only supported for tickets'),
    'expected public comments to be available for approved bugs and features as well'
  );
});
