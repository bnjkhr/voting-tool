// Aktionen hinter den MCP-Werkzeugen, die mehr als einen Aufruf brauchen oder
// Eingaben auf die API abbilden. Ohne Abhängigkeiten, damit sie sich ohne
// MCP-SDK testen lassen. `api(method, path, body)` ist apiRequest aus server.js.

// Muss RESOLVED_STATUSES in api/index.js entsprechen (ein Test vergleicht).
export const CLOSED_STATUSES = ['ist umgesetzt', 'wird nicht umgesetzt', 'gelöst', 'geschlossen'];

const PRIORITY_ORDER = ['kritisch', 'hoch', 'mittel', 'niedrig'];

const segment = (value) => encodeURIComponent(value);

function priorityRank(priority) {
  const rank = PRIORITY_ORDER.indexOf(priority);
  return rank === -1 ? PRIORITY_ORDER.length : rank;
}

function compareOpen(a, b) {
  return priorityRank(a.priority) - priorityRank(b.priority)
    || String(a.ticketNumber || '').localeCompare(String(b.ticketNumber || ''), 'de', { numeric: true });
}

async function listBoard(api, board) {
  const suggestions = await api('GET', `/apps/${segment(board)}/suggestions`);
  if (!Array.isArray(suggestions)) throw new Error('Unerwartete Antwort statt einer Liste.');
  return suggestions
    .filter((suggestion) => !CLOSED_STATUSES.includes(suggestion.status))
    .map(({ id, ticketNumber, type, status, priority, title, labels }) => (
      { id, ticketNumber, board, type, status, priority, title, labels }
    ));
}

// Holt freigegebenes, offenes Feedback aus den angeschlossenen Boards als
// Tickets. Mit dryRun nur zeigen, was geholt würde.
export function fetchFeedback(api, { dryRun } = {}) {
  return api('POST', '/feedback/fetch', dryRun === undefined ? {} : { dryRun });
}

export function linkEntry(api, { suggestionId, entryId }) {
  return api('PUT', `/suggestions/${segment(suggestionId)}/link`, { entryId });
}

export function unlinkEntry(api, { suggestionId }) {
  return api('DELETE', `/suggestions/${segment(suggestionId)}/link`);
}

// Holt vor dem Auflisten. Wirft nie: Was nicht geholt werden konnte, kommt als
// Eintrag zurück ({ board: null } = der ganze Aufruf).
async function fetchBeforeListing(api) {
  try {
    const result = await fetchFeedback(api);
    if (!Array.isArray(result?.sources)) throw new Error('Unerwartete Antwort beim Holen.');
    return result.sources
      .filter((source) => source.result === 'error' || source.error)
      .map((source) => ({ board: source.board, message: source.error || 'Die Quelle ließ sich nicht holen.' }));
  } catch (error) {
    return [{ board: null, message: error?.message || String(error) }];
  }
}

// Offene Einträge über alle Boards, nach dem Holen von neuem Feedback. Scheitert
// ein Board, steht es in `errors`, scheitert das Holen, in `fetchErrors`: Die
// Liste darf nie vollständig aussehen, wenn sie es nicht ist.
export async function listOpen(api, { appSlug } = {}) {
  const fetchErrors = await fetchBeforeListing(api);
  let boards = [appSlug];
  if (!appSlug) {
    const apps = await api('GET', '/apps');
    if (!Array.isArray(apps)) throw new Error('Unerwartete Antwort statt der Board-Liste.');
    boards = apps.map((app) => app.slug);
  }

  const results = await Promise.allSettled(boards.map((board) => listBoard(api, board)));
  const errors = results.flatMap((result, index) => (
    result.status === 'rejected'
      ? [{ board: boards[index], message: result.reason?.message || String(result.reason) }]
      : []
  ));
  const items = results.flatMap((result) => result.value || []).sort(compareOpen);

  // Fehler zuerst, damit sie in der Ausgabe vor der langen Liste stehen.
  return { fetchErrors, errors, items };
}

export function createBoard(api, { name, slug, ticketPrefix }) {
  return api('POST', '/apps', { boardName: name, boardSlug: slug, ticketPrefix });
}

export function listReleases(api, { appSlug, status }) {
  const query = status ? `?${new URLSearchParams({ status })}` : '';
  return api('GET', `/apps/${segment(appSlug)}/releases${query}`);
}

export function createRelease(api, { appSlug, ...fields }) {
  return api('POST', `/apps/${segment(appSlug)}/releases`, fields);
}

export function updateRelease(api, { releaseId, ...fields }) {
  return api('PATCH', `/releases/${segment(releaseId)}`, fields);
}

// releaseId null löst die Zuordnung.
export function assignRelease(api, { suggestionId, releaseId }) {
  return api('PUT', `/suggestions/${segment(suggestionId)}/release`, { releaseId });
}
