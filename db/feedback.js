'use strict';

// Repository für angeschlossene öffentliche Boards (feedback_sources) und die
// Verknüpfungen interner Tickets mit öffentlichen Einträgen (feedback_links).
// Eine Verknüpfung ohne suggestion_id ist ein Grabstein: Der Eintrag wurde
// schon einmal geholt oder gelöst und wird nicht erneut zum Ticket.
const crypto = require('crypto');
const { query, withTransaction } = require('./pool');
const { mapRow, mapRows } = require('./rows');
const apps = require('./apps');
const suggestions = require('./suggestions');

class NotPrivateError extends Error {
  constructor() {
    super('Verknüpfungen gibt es nur in privaten Workspaces.');
    this.code = 'NOT_PRIVATE';
  }
}

class SourceInUseError extends Error {
  constructor() {
    super('Dieses Board hat schon Verknüpfungen mit einer anderen Quelle.');
    this.code = 'SOURCE_IN_USE';
  }
}

class LinkConflictError extends Error {
  constructor() {
    super('Der Eintrag oder das Ticket ist schon verknüpft.');
    this.code = 'LINK_CONFLICT';
  }
}

class NoSourceError extends Error {
  constructor() {
    super('An diesem Board ist keine öffentliche Quelle angeschlossen.');
    this.code = 'NO_SOURCE';
  }
}

const SOURCE_COLUMNS = `
  id, tenant_id, app_id, source_kind, source_tenant_id, source_app_id,
  fetch_enabled, last_fetched_at, unapproved_count, last_error, created_at
`;

const LINK_COLUMNS = `
  id, tenant_id, source_id, entry_id, suggestion_id, public_type, public_status,
  public_approved, public_deleted, public_seen_at, created_at
`;

const prefixed = (columns, alias) => columns.split(',')
  .map((column) => `${alias}.${column.trim()}`)
  .join(', ');

// Legt die Quelle eines Boards an oder ändert sie. Dass Board und Workspace
// zusammengehören und der Workspace privat ist, prüft der Insert selbst. Eine
// geänderte Quelle ist ausgeschaltet, bis jemand sie wieder einschaltet; hängen
// schon Verknüpfungen an der alten, bleibt sie (deren IDs gälten sonst für die
// neue Quelle).
async function upsertSource({ tenantId, appId, sourceKind, sourceTenantId = null, sourceAppId }) {
  return withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      `select id, source_kind, source_tenant_id, source_app_id
         from feedback_sources where app_id = $1 and tenant_id = $2 for update`,
      [appId, tenantId]
    );
    const current = existing[0];
    const changed = Boolean(current) && (current.source_kind !== sourceKind
      || current.source_tenant_id !== sourceTenantId
      || current.source_app_id !== sourceAppId);
    if (changed) {
      const linked = await client.query(
        'select 1 from feedback_links where source_id = $1 limit 1', [current.id]
      );
      if (linked.rowCount > 0) throw new SourceInUseError();
    }

    const { rows } = await client.query(
      `insert into feedback_sources (tenant_id, app_id, source_kind, source_tenant_id, source_app_id)
       select t.id, a.id, $3, $4, $5
         from tenants t join apps a on a.tenant_id = t.id
        where t.id = $1 and a.id = $2 and t.status = 'private'
       on conflict (app_id) do update set
         source_kind = excluded.source_kind,
         source_tenant_id = excluded.source_tenant_id,
         source_app_id = excluded.source_app_id,
         fetch_enabled = case when $6 then false else feedback_sources.fetch_enabled end,
         last_fetched_at = case when $6 then null else feedback_sources.last_fetched_at end,
         unapproved_count = case when $6 then 0 else feedback_sources.unapproved_count end,
         last_error = case when $6 then null else feedback_sources.last_error end
       returning ${SOURCE_COLUMNS}`,
      [tenantId, appId, sourceKind, sourceTenantId, sourceAppId, changed]
    );
    if (!rows[0]) throw new NotPrivateError();
    return mapRow(rows[0]);
  });
}

async function setFetchEnabled(sourceId, enabled) {
  const { rows } = await query(
    `update feedback_sources set fetch_enabled = $2 where id = $1 returning ${SOURCE_COLUMNS}`,
    [sourceId, Boolean(enabled)]
  );
  return mapRow(rows[0]);
}

const SELECT_SOURCES = `
  select ${prefixed(SOURCE_COLUMNS, 's')}, a.name as board_name, a.slug as board_slug
    from feedback_sources s
    join apps a on a.id = s.app_id and a.tenant_id = s.tenant_id
   where s.tenant_id = $1`;

async function listSources(tenantId) {
  const { rows } = await query(`${SELECT_SOURCES} order by a.name asc, s.id asc`, [tenantId]);
  return mapRows(rows);
}

async function findSourceByApp(tenantId, appId) {
  const { rows } = await query(`${SELECT_SOURCES} and s.app_id = $2`, [tenantId, appId]);
  return mapRow(rows[0]);
}

// Setzt die 5-Minuten-Marke in einem einzigen Update: Von gleichzeitigen
// Aufrufen bekommt genau einer die Zeile zurück.
async function claimFetch(sourceId) {
  const { rowCount } = await query(
    `update feedback_sources set last_fetched_at = now()
      where id = $1 and fetch_enabled
        and (last_fetched_at is null or last_fetched_at < now() - interval '5 minutes')
      returning id`,
    [sourceId]
  );
  return rowCount > 0;
}

// Ergebnis eines Holvorgangs. Ohne `unapprovedCount` (Fehler) bleibt die
// zuletzt gezählte Anzahl stehen. `releaseMarker`: Es stehen noch Einträge aus,
// der nächste Aufruf darf ohne die 5 Minuten weitermachen.
async function recordFetch(sourceId, { unapprovedCount = null, error = null, releaseMarker = false } = {}) {
  await query(
    `update feedback_sources
        set unapproved_count = coalesce($2::int, unapproved_count), last_error = $3,
            last_fetched_at = case when $4::bool then null else last_fetched_at end
      where id = $1`,
    [sourceId, unapprovedCount, error, releaseMarker]
  );
}

const SELECT_LINKS = `
  select ${prefixed(LINK_COLUMNS, 'l')},
         s.app_id, s.source_kind, s.source_tenant_id, s.source_app_id
    from feedback_links l
    join feedback_sources s on s.id = l.source_id and s.tenant_id = l.tenant_id`;

async function listLinks(tenantId) {
  const { rows } = await query(
    `${SELECT_LINKS} where l.tenant_id = $1 order by l.created_at asc, l.id asc`,
    [tenantId]
  );
  return mapRows(rows);
}

async function listLinksBySource(sourceId) {
  const { rows } = await query(
    `${SELECT_LINKS} where l.source_id = $1 order by l.created_at asc, l.id asc`,
    [sourceId]
  );
  return mapRows(rows);
}

// Ticket, Ticketnummer und Verknüpfung in einer Transaktion. Zuerst die
// Verknüpfung: Wer ein Rennen verliert, wartet am Unique-Index auf den Sieger,
// bekommt dann keine Zeile und legt nichts an. Workspace und Board kommen aus der
// Zeile der Quelle, nie aus dem Aufruf.
// Wurde die Quelle seit dem Lesen umgehängt, gehören die Einträge nicht mehr zu
// ihr, und wurde das Holen inzwischen ausgeschaltet, soll ein laufender Lauf
// aufhören: In beiden Fällen entsteht nichts (`for share` hält die Zeile bis zum
// Commit).
async function createTicketWithLink({ source, entry, ticket }) {
  return withTransaction(async (client) => {
    const exec = (text, params) => client.query(text, params);
    const { rows } = await exec(
      `insert into feedback_links
         (tenant_id, source_id, entry_id, public_type, public_status, public_approved, public_seen_at)
       select s.tenant_id, s.id, $2, $3, $4, $5, now()
         from feedback_sources s
         join tenants t on t.id = s.tenant_id and t.status = 'private'
        where s.id = $1 and s.source_app_id = $6 and s.fetch_enabled
          for share of s
       on conflict do nothing
       returning id, tenant_id, source_id`,
      [source.id, entry.id, entry.type, entry.status, entry.approved, source.sourceAppId]
    );
    const link = rows[0];
    if (!link) return { created: false };

    const { rows: [target] } = await exec(
      'select app_id from feedback_sources where id = $1', [link.source_id]
    );
    const { ticketNumber } = await apps.nextTicketNumber(target.app_id, exec);
    const suggestion = await suggestions.insertSuggestion(exec, {
      ...ticket,
      id: crypto.randomUUID(),
      tenantId: link.tenant_id,
      appId: target.app_id,
      ticketNumber,
    });
    await exec('update feedback_links set suggestion_id = $2 where id = $1', [link.id, suggestion.id]);
    return { created: true, suggestion };
  });
}

// Zuletzt gesehener öffentlicher Stand, in einer Abfrage. Geschrieben wird nur,
// was sich geändert hat oder noch nie gesehen wurde; `public_seen_at` ist also
// der Zeitpunkt der letzten Änderung. Bei `publicDeleted` bleiben Status, Typ
// und dieser Zeitpunkt stehen. Liefert die Anzahl geschriebener Verknüpfungen.
async function refreshLinks(changes) {
  if (changes.length === 0) return 0;
  const column = (key, fallback = null) => changes.map((change) => change[key] ?? fallback);
  const { rowCount } = await query(
    `update feedback_links l set
       public_status = case when c.deleted then l.public_status else c.status end,
       public_type = case when c.deleted then l.public_type else c.type end,
       public_approved = case when c.deleted then l.public_approved else c.approved end,
       public_deleted = c.deleted,
       public_seen_at = case when c.deleted then l.public_seen_at else now() end
     from unnest($1::text[], $2::text[], $3::text[], $4::bool[], $5::bool[])
       as c(id, status, type, approved, deleted)
    where l.id = c.id and (
      l.public_deleted <> c.deleted
      or (not c.deleted and (
        l.public_seen_at is null
        or (l.public_status, l.public_type, l.public_approved)
           is distinct from (c.status, c.type, c.approved))))`,
    [
      column('linkId'), column('publicStatus'), column('publicType'),
      column('publicApproved'), column('publicDeleted', false),
    ]
  );
  return rowCount;
}

// Verknüpft ein vorhandenes Ticket von Hand. Ein Grabstein bekommt das neue
// Ticket; sein alter öffentlicher Stand wird erst beim nächsten Holen neu
// gefüllt. Ob schon verknüpft ist, entscheiden die Unique-Indizes.
async function linkSuggestion({ tenantId, suggestionId, entryId }) {
  let rows;
  try {
    ({ rows } = await query(
      `insert into feedback_links (tenant_id, source_id, entry_id, suggestion_id)
       select s.tenant_id, s.id, $3, g.id
         from suggestions g
         join feedback_sources s on s.app_id = g.app_id and s.tenant_id = g.tenant_id
         join tenants t on t.id = s.tenant_id and t.status = 'private'
        where g.tenant_id = $1 and g.id = $2
       on conflict (source_id, entry_id) do update set
         suggestion_id = excluded.suggestion_id,
         public_type = null, public_status = null, public_approved = null,
         public_deleted = false, public_seen_at = null
       where feedback_links.suggestion_id is null
       returning ${LINK_COLUMNS}`,
      [tenantId, suggestionId, entryId]
    ));
  } catch (error) {
    // Das Ticket hängt schon an einem anderen Eintrag.
    if (error.code === '23505') throw new LinkConflictError();
    throw error;
  }
  if (rows[0]) return mapRow(rows[0]);

  // Keine Zeile: keine Quelle, schon genau so verknüpft, oder der Eintrag
  // gehört zu einem anderen Ticket.
  const { rows: found } = await query(
    `select ${prefixed(LINK_COLUMNS, 'l')}
       from suggestions g
       join feedback_sources s on s.app_id = g.app_id and s.tenant_id = g.tenant_id
       join tenants t on t.id = s.tenant_id and t.status = 'private'
       left join feedback_links l on l.source_id = s.id and l.entry_id = $3
      where g.tenant_id = $1 and g.id = $2`,
    [tenantId, suggestionId, entryId]
  );
  if (!found[0]) throw new NoSourceError();
  if (found[0].suggestion_id === suggestionId) return mapRow(found[0]);
  throw new LinkConflictError();
}

async function unlinkSuggestion({ tenantId, suggestionId }) {
  const { rowCount } = await query(
    'update feedback_links set suggestion_id = null where tenant_id = $1 and suggestion_id = $2',
    [tenantId, suggestionId]
  );
  return rowCount > 0;
}

module.exports = {
  NotPrivateError,
  SourceInUseError,
  LinkConflictError,
  NoSourceError,
  upsertSource,
  setFetchEnabled,
  listSources,
  findSourceByApp,
  claimFetch,
  recordFetch,
  listLinks,
  listLinksBySource,
  createTicketWithLink,
  refreshLinks,
  linkSuggestion,
  unlinkSuggestion,
};
