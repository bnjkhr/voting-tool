#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  assignRelease,
  createBoard,
  createRelease,
  listOpen,
  listReleases,
  updateRelease,
} from './actions.js';

const API_BASE = (process.env.VOTING_TOOL_API_BASE || 'https://roadlight.pro/api/v1').replace(/\/$/, '');
const API_KEY = process.env.VOTING_TOOL_API_KEY;

if (!API_KEY) {
  console.error('[voting-tool-mcp] Fehlende Env-Variable VOTING_TOOL_API_KEY. Im Tenant-Admin-UI unter "API-Schlüssel" erstellen.');
  process.exit(1);
}

async function apiRequest(method, path, body) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body == null ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }

  if (!res.ok) {
    const errorMessage = parsed && typeof parsed === 'object' && parsed.error
      ? parsed.error
      : `HTTP ${res.status} ${res.statusText}`;
    throw new Error(`${method} ${path} → ${errorMessage}`);
  }

  return parsed;
}

function ok(data) {
  return {
    content: [{
      type: 'text',
      text: typeof data === 'string' ? data : JSON.stringify(data, null, 2),
    }],
  };
}

function fail(error) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: error?.message || String(error),
    }],
  };
}

const server = new McpServer({
  name: 'voting-tool',
  version: '1.0.0',
});

server.tool(
  'voting_whoami',
  'Liefert Tenant- und Scope-Info zum aktuellen API-Key. Sanity-Check.',
  {},
  async () => {
    try { return ok(await apiRequest('GET', '/me')); }
    catch (error) { return fail(error); }
  }
);

server.tool(
  'voting_list_apps',
  'Listet alle Boards (Apps) im Workspace des API-Keys auf. Gibt id, slug, name und ticketPrefix zurück.',
  {},
  async () => {
    try { return ok(await apiRequest('GET', '/apps')); }
    catch (error) { return fail(error); }
  }
);

server.tool(
  'voting_list_suggestions',
  'Listet Einträge (Features, Bugs, Tickets) für ein Board. appSlug ist erforderlich. Optional nach Typ, Status oder Freigabe filtern.',
  {
    appSlug: z.string().describe('Slug des Boards (siehe voting_list_apps).'),
    type: z.enum(['feature', 'bug', 'ticket']).optional().describe('Filter nach Eintragstyp.'),
    status: z.string().optional().describe('Filter nach Status (z.B. "wird umgesetzt", "neu", "gelöst").'),
    approved: z.enum(['true', 'false']).optional().describe('Nur freigegebene (true) oder nur wartende (false) Einträge.'),
  },
  async ({ appSlug, type, status, approved }) => {
    try {
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (status) params.set('status', status);
      if (approved) params.set('approved', approved);
      const qs = params.toString();
      return ok(await apiRequest('GET', `/apps/${encodeURIComponent(appSlug)}/suggestions${qs ? `?${qs}` : ''}`));
    } catch (error) { return fail(error); }
  }
);

server.tool(
  'voting_create_suggestion',
  'Erstellt einen neuen Eintrag in einem Board. Wird automatisch freigegeben (Scope suggestions:write nötig). Pflichtfelder: appSlug, type, title, description. Für type=bug zusätzlich severity, stepsToReproduce, expectedBehavior, actualBehavior.',
  {
    appSlug: z.string().describe('Slug des Boards.'),
    type: z.enum(['feature', 'bug', 'ticket']).describe('Eintragstyp.'),
    title: z.string().max(100).describe('Kurzer Titel.'),
    description: z.string().max(1000).describe('Ausführlichere Beschreibung.'),
    priority: z.enum(['niedrig', 'mittel', 'hoch', 'kritisch']).optional().describe('Nur für tickets / feature relevant.'),
    severity: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Bei Bugs erforderlich.'),
    stepsToReproduce: z.string().max(2000).optional().describe('Bei Bugs erforderlich.'),
    expectedBehavior: z.string().max(1000).optional().describe('Bei Bugs erforderlich.'),
    actualBehavior: z.string().max(1000).optional().describe('Bei Bugs erforderlich.'),
    environment: z.object({
      appVersion: z.string().max(100).optional(),
      platform: z.string().max(100).optional(),
      browser: z.string().max(100).optional(),
    }).optional(),
  },
  async (input) => {
    try {
      const { appSlug, ...body } = input;
      return ok(await apiRequest('POST', `/apps/${encodeURIComponent(appSlug)}/suggestions`, body));
    } catch (error) { return fail(error); }
  }
);

server.tool(
  'voting_get_suggestion',
  'Lädt einen einzelnen Eintrag per ID.',
  {
    suggestionId: z.string().describe('Firestore-Document-ID des Eintrags.'),
  },
  async ({ suggestionId }) => {
    try { return ok(await apiRequest('GET', `/suggestions/${encodeURIComponent(suggestionId)}`)); }
    catch (error) { return fail(error); }
  }
);

server.tool(
  'voting_update_suggestion',
  'Aktualisiert Status, Priorität und/oder Labels eines Eintrags. Mindestens eines der drei Felder muss angegeben werden. Benötigt Scope suggestions:status.',
  {
    suggestionId: z.string(),
    status: z.string().optional().describe('Neuer Status (z.B. "wird umgesetzt", "gelöst").'),
    priority: z.enum(['niedrig', 'mittel', 'hoch', 'kritisch']).optional(),
    labels: z.array(z.string()).max(20).optional(),
  },
  async ({ suggestionId, ...body }) => {
    try { return ok(await apiRequest('PATCH', `/suggestions/${encodeURIComponent(suggestionId)}`, body)); }
    catch (error) { return fail(error); }
  }
);

server.tool(
  'voting_list_comments',
  'Listet alle Kommentare für einen Eintrag (auch wartende). Benötigt Scope comments:read.',
  {
    suggestionId: z.string(),
  },
  async ({ suggestionId }) => {
    try { return ok(await apiRequest('GET', `/suggestions/${encodeURIComponent(suggestionId)}/comments`)); }
    catch (error) { return fail(error); }
  }
);

server.tool(
  'voting_add_comment',
  'Fügt einen Admin-Kommentar zu einem Eintrag hinzu. Wird automatisch freigegeben. Benötigt Scope comments:write.',
  {
    suggestionId: z.string(),
    text: z.string().max(2000),
  },
  async ({ suggestionId, text }) => {
    try { return ok(await apiRequest('POST', `/suggestions/${encodeURIComponent(suggestionId)}/comments`, { text })); }
    catch (error) { return fail(error); }
  }
);

// Werkzeug, dessen Ablauf in actions.js liegt.
function actionTool(name, description, shape, action) {
  server.tool(name, description, shape, async (input) => {
    try { return ok(await action(apiRequest, input)); }
    catch (error) { return fail(error); }
  });
}

const releaseStatus = z.enum(['geplant', 'in Arbeit', 'veröffentlicht']);
const releaseFields = {
  title: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  status: releaseStatus.optional(),
};

actionTool(
  'voting_list_open',
  'Listet alle offenen Einträge über alle Boards, nach Priorität sortiert (erledigte und abgelehnte fehlen). Boards, die nicht abrufbar waren, stehen in errors; dann ist die Liste unvollständig. Benötigt Scope suggestions:read.',
  {
    appSlug: z.string().optional().describe('Nur dieses Board (siehe voting_list_apps).'),
  },
  listOpen
);

actionTool(
  'voting_create_board',
  'Legt ein neues Board an. Benötigt Scope boards:write.',
  {
    name: z.string().max(120),
    slug: z.string().optional().describe('Ohne Angabe aus dem Namen abgeleitet.'),
    ticketPrefix: z.string().max(5).optional().describe('Buchstaben für Ticketnummern, ohne Angabe aus dem Namen.'),
  },
  createBoard
);

actionTool(
  'voting_list_releases',
  'Listet die Releases eines Boards. Benötigt Scope releases:read.',
  {
    appSlug: z.string(),
    status: releaseStatus.optional(),
  },
  listReleases
);

actionTool(
  'voting_create_release',
  'Legt ein Release in einem Board an. Benötigt Scope releases:write.',
  {
    appSlug: z.string(),
    version: z.string().max(50),
    ...releaseFields,
    releaseDate: z.string().optional().describe('Datum, z.B. "2026-12-01".'),
  },
  createRelease
);

actionTool(
  'voting_update_release',
  'Ändert ein Release; nur die übergebenen Felder. Benötigt Scope releases:write.',
  {
    releaseId: z.string(),
    version: z.string().max(50).optional(),
    ...releaseFields,
    releaseDate: z.string().nullable().optional().describe('null entfernt das Datum.'),
  },
  updateRelease
);

actionTool(
  'voting_assign_release',
  'Ordnet einen Eintrag einem Release desselben Boards zu oder löst die Zuordnung (releaseId null). Benötigt Scope releases:write.',
  {
    suggestionId: z.string(),
    releaseId: z.string().nullable(),
  },
  assignRelease
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[voting-tool-mcp] verbunden — API: ${API_BASE}`);
