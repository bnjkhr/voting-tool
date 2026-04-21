const RESOLVED_STATUSES = ['ist umgesetzt', 'wird nicht umgesetzt', 'gelöst', 'geschlossen'];

function getAdminSuggestionSortBucket(suggestion = {}) {
  if (suggestion.approved !== true) {
    return 0;
  }

  if ((suggestion.pendingCommentCount || 0) > 0) {
    return 1;
  }

  return 2;
}

function getSuggestionCreatedAt(suggestion = {}) {
  return suggestion.createdAt?.toDate?.() || suggestion.createdAt || new Date(0);
}

function compareAdminSuggestions(a, b) {
  const aBucket = getAdminSuggestionSortBucket(a);
  const bBucket = getAdminSuggestionSortBucket(b);
  if (aBucket !== bBucket) {
    return aBucket - bBucket;
  }

  const aResolved = RESOLVED_STATUSES.includes(a.status) ? 1 : 0;
  const bResolved = RESOLVED_STATUSES.includes(b.status) ? 1 : 0;
  if (aResolved !== bResolved) {
    return aResolved - bResolved;
  }

  if ((b.votes || 0) !== (a.votes || 0)) {
    return (b.votes || 0) - (a.votes || 0);
  }

  return getSuggestionCreatedAt(b) - getSuggestionCreatedAt(a);
}

module.exports = {
  compareAdminSuggestions,
  getAdminSuggestionSortBucket,
};
