'use strict';

// Routenlisten für den privaten Workspace, geteilt vom Attrappen-Test
// (private-workspace.test.js) und vom Postgres-Test. Jede Route ohne
// Anmelde-Prüfung steht in genau einer der beiden Listen; eine neue Route fällt
// so lange durch, bis jemand sie hier einordnet.
const fs = require('node:fs');
const path = require('node:path');

const MARKER = 'GEHEIM-MARKER';

// Öffentliche Routen eines Workspaces: Für `private` antwortet jede wie für
// einen unbekannten Slug. `postgresOnly`: Unter Firestore endet die Route vor
// dem Nachschlagen des Workspaces.
const TENANT_ROUTES = [
  { route: 'GET /api/tenants/:tenantSlug' },
  { route: 'GET /api/tenants/:tenantSlug/apps' },
  { route: 'GET /api/tenants/:tenantSlug/apps/:appSlug' },
  { route: 'GET /api/tenants/:tenantSlug/apps/:appSlug/suggestions' },
  {
    route: 'POST /api/tenants/:tenantSlug/apps/:appSlug/suggestions',
    body: { type: 'feature', title: 'Titel', description: 'Beschreibung' },
  },
  { route: 'GET /api/tenants/:tenantSlug/apps/:appSlug/releases' },
  { route: 'GET /api/tenants/:tenantSlug/suggestions/:suggestionId/comments' },
  { route: 'GET /api/tenants/:tenantSlug/attachments/:attachmentId', postgresOnly: true },
  { route: 'POST /api/tenants/:tenantSlug/suggestions/:suggestionId/vote' },
  { route: 'DELETE /api/tenants/:tenantSlug/suggestions/:suggestionId/vote' },
  { route: 'GET /api/tenants/:tenantSlug/suggestions/:suggestionId/voted' },
  {
    route: 'POST /api/tenants/:tenantSlug/suggestions/:suggestionId/comments',
    body: { text: 'Kommentar' },
  },
];

const HTML_SHELL = 'HTML-Hülle; die Link-Vorschau liest nur Apps des Alt-Bereichs.';
const LEGACY = 'Alt-Bereich: filtert auf den Tenant `legacy`.';
const LOGIN = 'Anmeldung: gibt ohne gültigen Schlüssel oder Link nichts über Workspaces aus.';
const INVITE = 'Einladung: löst nur aktive Workspaces auf.';
const NOTIFICATIONS = 'Liest und schreibt nur die Firestore-Einstellungen zum Fingerabdruck.';

// Bot-Schutz der Formulare passieren, damit die Anfrage den Handler erreicht.
const HUMAN = { website: '', formElapsedMs: 60000 };

// Alle übrigen Routen ohne Anmelde-Prüfung, aufgerufen mit den echten IDs des
// privaten Workspaces. `url` ersetzt den Pfad, wo Parameter allein nicht reichen.
const OTHER_PUBLIC_ROUTES = [
  { route: 'GET /', reason: HTML_SHELL, url: (ids) => `/?appId=${ids.appId}` },
  { route: 'GET /admin', reason: 'Weiterleitung auf die statische Admin-Seite.' },
  { route: 'GET /admin/', reason: 'Weiterleitung auf die statische Admin-Seite.' },
  { route: 'GET *', reason: HTML_SHELL, url: (ids) => `/${ids.tenantSlug}/${ids.appSlug}?appId=${ids.appId}` },
  { route: 'GET /api/auth/bot-protection', reason: 'Nur der öffentliche Turnstile-Schlüssel.' },
  { route: 'POST /api/auth/logout', reason: LOGIN },
  {
    route: 'POST /api/auth/login-links',
    reason: LOGIN,
    body: { ...HUMAN, email: 'unbekannt@example.test' },
  },
  {
    route: 'POST /api/signup/workspaces',
    reason: 'Registrierung: ein vergebener Slug wird abgewiesen, ohne Inhalte zu nennen.',
    body: (ids) => ({
      ...HUMAN, confirmBusinessCustomer: true, email: ids.email, workspaceName: ids.tenantSlug,
    }),
  },
  {
    route: 'POST /api/auth/login-links/:token/consume',
    reason: LOGIN,
    url: () => '/api/auth/login-links/unbekannt/consume',
  },
  { route: 'GET /api/auth/session', reason: LOGIN },
  { route: 'GET /api/invites/:token', reason: INVITE, url: (ids) => `/api/invites/${ids.inviteToken}` },
  {
    route: 'POST /api/invites/:token/accept',
    reason: INVITE,
    url: (ids) => `/api/invites/${ids.inviteToken}/accept`,
    body: { displayName: 'Fremd' },
  },
  { route: 'GET /api/apps', reason: LEGACY },
  { route: 'GET /api/apps/:appId/suggestions', reason: LEGACY },
  {
    route: 'POST /api/apps/:appId/suggestions',
    reason: LEGACY,
    body: { type: 'feature', title: 'Titel', description: 'Beschreibung' },
  },
  { route: 'POST /api/suggestions/:suggestionId/vote', reason: LEGACY },
  { route: 'DELETE /api/suggestions/:suggestionId/vote', reason: LEGACY },
  { route: 'GET /api/suggestions/:suggestionId/voted', reason: LEGACY },
  {
    route: 'POST /api/stripe/webhook',
    reason: 'Nur mit gültiger Stripe-Signatur.',
    body: { id: 'evt_unsigniert' },
  },
  {
    route: 'POST /api/suggestions/:suggestionId/comments',
    reason: LEGACY,
    body: { text: 'Kommentar' },
  },
  { route: 'GET /api/suggestions/:suggestionId/comments', reason: LEGACY },
  { route: 'GET /api/user/notification-settings', reason: NOTIFICATIONS },
  {
    route: 'PUT /api/user/notification-settings',
    reason: NOTIFICATIONS,
    body: { email: 'keine-adresse' },
  },
  { route: 'GET /api/apps/:appId/releases', reason: LEGACY },
];

// Aus "GET /pfad/:name" und den IDs die Anfrage bauen.
function buildRequest(entry, ids) {
  const [method, pattern] = entry.route.split(' ');
  const url = entry.url
    ? entry.url(ids)
    : pattern.replace(/:(\w+)/g, (_, name) => {
      if (!ids[name]) throw new Error(`Kein Wert für :${name} in ${entry.route}`);
      return ids[name];
    });
  const body = typeof entry.body === 'function' ? entry.body(ids) : entry.body;
  return { method, url, body };
}

const REGISTRATION = /^app\.(get|post|put|patch|delete|all)\((\[[^\]]*\]|'[^']*')\s*,(.*)$/;
const AUTH_MIDDLEWARE = /\b(requireAdminAuth\b|requireTenantAccess\(|requireApiKey\()/;

// Alle Routen aus api/index.js. Eine Zeile in unbekannter Form bricht ab, statt
// still aus der Prüfung zu fallen.
function readRegistrations() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  return source
    .split(/\r?\n/)
    .filter((line) => /\bapp\.(get|post|put|patch|delete|all|route)\(/.test(line))
    .flatMap((line) => {
      const match = line.match(REGISTRATION);
      if (!match) throw new Error(`Routen-Zeile nicht lesbar: ${line.trim()}`);
      const [, method, paths, rest] = match;
      return [...paths.matchAll(/'([^']*)'/g)].map(([, routePath]) => ({
        route: `${method.toUpperCase()} ${routePath}`,
        handlers: rest,
      }));
    });
}

function readUnauthenticatedRoutes() {
  return readRegistrations()
    .filter(({ handlers }) => !AUTH_MIDDLEWARE.test(handlers))
    .map(({ route }) => route);
}

module.exports = {
  MARKER,
  OTHER_PUBLIC_ROUTES,
  TENANT_ROUTES,
  buildRequest,
  readRegistrations,
  readUnauthenticatedRoutes,
};
