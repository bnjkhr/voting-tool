const {
  LEGACY_TENANT_ID,
  buildAppSlug,
  buildLegacyTenantData,
  getTenantId,
  normalizeSlug,
} = require('../api/tenant-utils');
const {
  admin,
  initFirestore,
  loadDotEnvFileIfPresent,
} = require('./firebase-admin-utils');

function createUniqueSlug(baseSlug, usedSlugs) {
  let candidate = baseSlug || 'app';
  let suffix = 2;

  while (usedSlugs.has(candidate)) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  usedSlugs.add(candidate);
  return candidate;
}

function chunk(values, size = 400) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

async function ensureLegacyTenant(db, dryRun) {
  const tenantRef = db.collection('tenants').doc(LEGACY_TENANT_ID);
  const tenantDoc = await tenantRef.get();
  const timestampValue = admin.firestore.FieldValue.serverTimestamp();

  if (tenantDoc.exists) {
    const update = {
      slug: normalizeSlug(tenantDoc.data().slug || LEGACY_TENANT_ID, { fallback: LEGACY_TENANT_ID }),
      updatedAt: timestampValue,
      legacy: true,
    };

    if (dryRun) {
      console.log(`[dry-run] Would update tenant ${LEGACY_TENANT_ID}:`, update);
      return;
    }

    await tenantRef.set(update, { merge: true });
    console.log(`Updated tenant ${LEGACY_TENANT_ID}`);
    return;
  }

  const tenantData = buildLegacyTenantData(timestampValue);

  if (dryRun) {
    console.log(`[dry-run] Would create tenant ${LEGACY_TENANT_ID}:`, {
      ...tenantData,
      createdAt: '<serverTimestamp>',
      updatedAt: '<serverTimestamp>',
    });
    return;
  }

  await tenantRef.set(tenantData, { merge: true });
  console.log(`Created tenant ${LEGACY_TENANT_ID}`);
}

async function planAppUpdates(db) {
  const snapshot = await db.collection('apps').get();
  const usedSlugs = new Set();
  const appInfo = new Map();
  const updates = [];

  snapshot.docs.forEach(doc => {
    const existingSlug = normalizeSlug(doc.data().slug, { fallback: '' });
    if (existingSlug) {
      usedSlugs.add(existingSlug);
    }
  });

  snapshot.docs.forEach(doc => {
    const data = doc.data();
    const update = {};
    const existingSlug = normalizeSlug(data.slug, { fallback: '' });

    if (!data.tenantId) {
      update.tenantId = LEGACY_TENANT_ID;
    }

    if (!existingSlug) {
      update.slug = createUniqueSlug(buildAppSlug(data.name || doc.id), usedSlugs);
    }

    const merged = { ...data, ...update };
    appInfo.set(doc.id, {
      tenantId: getTenantId(merged),
    });

    if (Object.keys(update).length > 0) {
      updates.push({ ref: doc.ref, data: update });
    }
  });

  return { appInfo, updates };
}

async function planSuggestionUpdates(db, appInfo) {
  const snapshot = await db.collection('suggestions').get();
  const suggestionInfo = new Map();
  const updates = [];

  snapshot.docs.forEach(doc => {
    const data = doc.data();
    const fallbackTenantId = appInfo.get(data.appId)?.tenantId || LEGACY_TENANT_ID;
    const update = {};

    if (!data.tenantId) {
      update.tenantId = fallbackTenantId;
    }

    const merged = { ...data, ...update };
    suggestionInfo.set(doc.id, {
      tenantId: getTenantId(merged),
    });

    if (Object.keys(update).length > 0) {
      updates.push({ ref: doc.ref, data: update });
    }
  });

  return { suggestionInfo, updates };
}

async function planRelatedUpdates(db, collectionName, relationField, infoMap) {
  const snapshot = await db.collection(collectionName).get();
  const updates = [];

  snapshot.docs.forEach(doc => {
    const data = doc.data();
    const fallbackTenantId = infoMap.get(data[relationField])?.tenantId || LEGACY_TENANT_ID;
    if (!data.tenantId) {
      updates.push({
        ref: doc.ref,
        data: { tenantId: fallbackTenantId },
      });
    }
  });

  return updates;
}

async function planCounterUpdates(db, appInfo) {
  const snapshot = await db.collection('counters').get();
  const updates = [];

  snapshot.docs.forEach(doc => {
    if (!doc.data().tenantId) {
      updates.push({
        ref: doc.ref,
        data: {
          tenantId: appInfo.get(doc.id)?.tenantId || LEGACY_TENANT_ID,
        },
      });
    }
  });

  return updates;
}

async function planUserSettingsUpdates(db) {
  const snapshot = await db.collection('userSettings').get();
  const updates = [];

  snapshot.docs.forEach(doc => {
    if (!doc.data().tenantId) {
      updates.push({
        ref: doc.ref,
        data: { tenantId: LEGACY_TENANT_ID },
      });
    }
  });

  return updates;
}

async function applyUpdates(db, updates, dryRun) {
  if (updates.length === 0) return;

  if (dryRun) {
    updates.forEach(update => {
      console.log(`[dry-run] Would update ${update.ref.path}:`, update.data);
    });
    return;
  }

  for (const entries of chunk(updates)) {
    const batch = db.batch();
    entries.forEach(update => {
      batch.set(update.ref, update.data, { merge: true });
    });
    await batch.commit();
  }
}

async function run() {
  loadDotEnvFileIfPresent();
  const dryRun = process.argv.includes('--dry-run');
  const db = initFirestore();

  console.log(`Bootstrap tenancy ${dryRun ? '(dry-run)' : ''}`.trim());

  await ensureLegacyTenant(db, dryRun);

  const { appInfo, updates: appUpdates } = await planAppUpdates(db);
  const { suggestionInfo, updates: suggestionUpdates } = await planSuggestionUpdates(db, appInfo);
  const voteUpdates = await planRelatedUpdates(db, 'votes', 'suggestionId', suggestionInfo);
  const commentUpdates = await planRelatedUpdates(db, 'comments', 'suggestionId', suggestionInfo);
  const activityUpdates = await planRelatedUpdates(db, 'activity', 'ticketId', suggestionInfo);
  const releaseUpdates = await planRelatedUpdates(db, 'releases', 'appId', appInfo);
  const counterUpdates = await planCounterUpdates(db, appInfo);
  const userSettingsUpdates = await planUserSettingsUpdates(db);

  const allUpdates = [
    ...appUpdates,
    ...suggestionUpdates,
    ...voteUpdates,
    ...commentUpdates,
    ...activityUpdates,
    ...releaseUpdates,
    ...counterUpdates,
    ...userSettingsUpdates,
  ];

  console.log(`Planned updates: ${allUpdates.length}`);
  console.log(`  apps: ${appUpdates.length}`);
  console.log(`  suggestions: ${suggestionUpdates.length}`);
  console.log(`  votes: ${voteUpdates.length}`);
  console.log(`  comments: ${commentUpdates.length}`);
  console.log(`  activity: ${activityUpdates.length}`);
  console.log(`  releases: ${releaseUpdates.length}`);
  console.log(`  counters: ${counterUpdates.length}`);
  console.log(`  userSettings: ${userSettingsUpdates.length}`);

  await applyUpdates(db, allUpdates, dryRun);

  console.log(dryRun ? 'Dry-run complete.' : 'Tenancy bootstrap complete.');
}

run().catch(error => {
  console.error('bootstrap-tenancy failed:', error);
  process.exit(1);
});
