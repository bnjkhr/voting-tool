const VALID_COMMENT_APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];
const VALID_COMMENT_AUTHOR_TYPES = ['admin', 'user'];

function normalizeCommentAuthorType(data = {}) {
  const normalized = (data.authorType || '').toString().trim().toLowerCase();
  if (VALID_COMMENT_AUTHOR_TYPES.includes(normalized)) {
    return normalized;
  }

  return data.authorFingerprint ? 'user' : 'admin';
}

function normalizeCommentApprovalStatus(data = {}) {
  const normalized = (data.approvalStatus || '').toString().trim().toLowerCase();
  if (VALID_COMMENT_APPROVAL_STATUSES.includes(normalized)) {
    return normalized;
  }

  return normalizeCommentAuthorType(data) === 'admin' ? 'approved' : 'pending';
}

function normalizeCommentData(data = {}) {
  const authorType = normalizeCommentAuthorType(data);
  const approvalStatus = normalizeCommentApprovalStatus({ ...data, authorType });

  return {
    ...data,
    text: typeof data.text === 'string' ? data.text : '',
    screenshots: Array.isArray(data.screenshots) ? data.screenshots : [],
    authorType,
    approvalStatus,
    authorFingerprint: data.authorFingerprint || null,
    approvedAt: data.approvedAt || null,
    approvedBy: data.approvedBy || null,
    rejectedAt: data.rejectedAt || null,
    rejectedBy: data.rejectedBy || null,
  };
}

function isCommentVisibleToPublic(data = {}) {
  return normalizeCommentApprovalStatus(data) === 'approved';
}

function buildPublicCommentResponse(doc) {
  const normalized = normalizeCommentData(doc.data());
  if (!isCommentVisibleToPublic(normalized)) {
    return null;
  }

  return {
    id: doc.id,
    text: normalized.text,
    screenshots: normalized.screenshots,
    createdAt: normalized.createdAt,
    authorType: normalized.authorType,
  };
}

function buildAdminCommentResponse(doc) {
  const normalized = normalizeCommentData(doc.data());
  return {
    id: doc.id,
    text: normalized.text,
    screenshots: normalized.screenshots,
    createdAt: normalized.createdAt,
    authorType: normalized.authorType,
    approvalStatus: normalized.approvalStatus,
    approvedAt: normalized.approvedAt,
    approvedBy: normalized.approvedBy,
    rejectedAt: normalized.rejectedAt,
    rejectedBy: normalized.rejectedBy,
  };
}

function buildCommentStats(commentDocs = []) {
  return commentDocs.reduce((stats, doc) => {
    const normalized = normalizeCommentData(doc.data());

    stats.totalCount += 1;
    if (normalized.approvalStatus === 'pending') {
      stats.pendingCount += 1;
    }
    if (normalized.approvalStatus === 'approved') {
      stats.publicCount += 1;
    }

    return stats;
  }, {
    totalCount: 0,
    pendingCount: 0,
    publicCount: 0,
  });
}

function validateCommentScreenshots(screenshots, {
  maxCount = 5,
  maxImageLength = 300000,
  maxTotalLength = 800000,
} = {}) {
  if (!screenshots) {
    return { screenshots: [] };
  }

  if (!Array.isArray(screenshots)) {
    return { error: 'Invalid screenshots payload' };
  }

  if (screenshots.length > maxCount) {
    return { error: `Maximum ${maxCount} screenshots allowed` };
  }

  const processedScreenshots = screenshots.filter(screenshot => (
    typeof screenshot === 'string' &&
    screenshot.startsWith('data:image/') &&
    screenshot.length < maxImageLength
  ));

  const totalSize = processedScreenshots.reduce((sum, screenshot) => sum + screenshot.length, 0);
  if (totalSize > maxTotalLength) {
    return { error: 'Screenshots total size too large. Please use smaller images.' };
  }

  return { screenshots: processedScreenshots };
}

module.exports = {
  buildAdminCommentResponse,
  buildCommentStats,
  buildPublicCommentResponse,
  isCommentVisibleToPublic,
  normalizeCommentApprovalStatus,
  normalizeCommentAuthorType,
  normalizeCommentData,
  validateCommentScreenshots,
};
