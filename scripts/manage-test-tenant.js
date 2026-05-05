const {
  LEGACY_TENANT_ID,
  getTenantId,
} = require('../api/tenant-utils');
const {
  DEFAULT_TEST_APP_SLUG,
  assertSafeTestTenantSlug,
  buildDefaultTestAppName,
  buildDefaultTestTenantName,
  buildTestAppSlug,
} = require('../api/test-tenant-utils');
const {
  admin,
  initFirestore,
  loadDotEnvFileIfPresent,
} = require('./firebase-admin-utils');

const COMMANDS = new Set(['create', 'delete']);

function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args[0];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = args[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return { command, options };
}

function requireOption(options, key) {
  const value = options[key];
  if (!value || value === true) {
    throw new Error(`Missing required option --${key}`);
  }
  return String(value);
}

function chunk(values, size = 400) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) {
    chunks.push(values.slice(i, i + size));
  }
  return chunks;
}

async function findExistingApp(db, tenantId, appSlug) {
  const snapshot = await db.collection('apps')
    .where('tenantId', '==', tenantId)
    .where('slug', '==', appSlug)
    .limit(2)
    .get();

  if (snapshot.size > 1) {
    throw new Error(`Multiple apps found for tenant ${tenantId} and slug ${appSlug}`);
  }

  return snapshot.empty ? null : snapshot.docs[0];
}

function buildSeedConfig(options) {
  const tenantSlug = assertSafeTestTenantSlug(requireOption(options, 'tenant-slug'));
  const tenantId = tenantSlug;
  const appSlug = buildTestAppSlug(options['app-slug'] || DEFAULT_TEST_APP_SLUG);
  const appName = String(options['app-name'] || buildDefaultTestAppName(tenantSlug));
  const tenantName = String(options['tenant-name'] || buildDefaultTestTenantName(tenantSlug));
  const testScope = `tenant:${tenantId}`;

  return {
    tenantId,
    tenantSlug,
    tenantName,
    appSlug,
    appName,
    testScope,
  };
}

function createSeedDocuments(config) {
  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const releaseDate = admin.firestore.Timestamp.fromDate(new Date('2030-01-15T00:00:00.000Z'));

  return {
    tenant: {
      name: config.tenantName,
      displayName: config.tenantName,
      slug: config.tenantSlug,
      status: 'active',
      legacy: false,
      isTestData: true,
      testScope: config.testScope,
      managedBy: 'manage-test-tenant',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    app: {
      tenantId: config.tenantId,
      name: config.appName,
      description: `Isoliertes Test-Board für ${config.tenantName}`,
      slug: config.appSlug,
      ticketPrefix: 'TEST',
      labels: ['staging', 'smoke-test'],
      isTestData: true,
      testScope: config.testScope,
      managedBy: 'manage-test-tenant',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    counter: {
      tenantId: config.tenantId,
      prefix: 'TEST',
      nextNumber: 3,
      isTestData: true,
      testScope: config.testScope,
      managedBy: 'manage-test-tenant',
      updatedAt: timestamp,
    },
    release: {
      tenantId: config.tenantId,
      version: '0.9.0-test',
      title: 'Staging Smoke Release',
      description: 'Nur für isolierte Tenant-Tests in der geteilten Datenbank.',
      status: 'geplant',
      releaseDate,
      publishedAt: null,
      isTestData: true,
      testScope: config.testScope,
      managedBy: 'manage-test-tenant',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    approvedFeature: {
      tenantId: config.tenantId,
      type: 'feature',
      title: 'Staging Feature Vorschlag',
      description: 'Genehmigter Feature-Eintrag für isolierte SaaS-Tests.',
      notificationEnabled: false,
      notificationEmail: null,
      votes: 3,
      approved: true,
      status: 'wird geprüft',
      priority: 'mittel',
      labels: ['staging'],
      userFingerprint: 'test-tenant-seed',
      ticketNumber: 'TEST-001',
      isTestData: true,
      testScope: config.testScope,
      managedBy: 'manage-test-tenant',
      createdAt: timestamp,
      approvedAt: timestamp,
      updatedAt: timestamp,
    },
    approvedBug: {
      tenantId: config.tenantId,
      type: 'bug',
      title: 'Staging Bug Report',
      description: 'Offener Bug-Eintrag für isolierte Tenant-Tests.',
      notificationEnabled: false,
      notificationEmail: null,
      votes: 0,
      approved: true,
      status: 'offen',
      priority: 'hoch',
      labels: ['staging'],
      severity: 'high',
      stepsToReproduce: '1. Testdaten öffnen\n2. Fehlerzustand prüfen',
      expectedBehavior: 'Alles lädt fehlerfrei.',
      actualBehavior: 'Der Testfehler bleibt sichtbar.',
      environment: {
        appVersion: '0.9.0-test',
        platform: 'web',
        browser: 'staging',
      },
      userFingerprint: 'test-tenant-seed',
      ticketNumber: 'TEST-002',
      isTestData: true,
      testScope: config.testScope,
      managedBy: 'manage-test-tenant',
      createdAt: timestamp,
      approvedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

async function ensureCreate(db, config, dryRun) {
  const docs = createSeedDocuments(config);
  const tenantRef = db.collection('tenants').doc(config.tenantId);
  const existingApp = await findExistingApp(db, config.tenantId, config.appSlug);
  const appRef = existingApp ? existingApp.ref : db.collection('apps').doc();
  const releaseRef = db.collection('releases').doc(`${config.tenantId}--${config.appSlug}--release`);
  const featureRef = db.collection('suggestions').doc(`${config.tenantId}--${config.appSlug}--feature`);
  const bugRef = db.collection('suggestions').doc(`${config.tenantId}--${config.appSlug}--bug`);
  const counterRef = db.collection('counters').doc(appRef.id);

  const appPayload = {
    ...docs.app,
  };

  const releasePayload = {
    ...docs.release,
    appId: appRef.id,
  };

  const featurePayload = {
    ...docs.approvedFeature,
    appId: appRef.id,
    releaseId: releaseRef.id,
  };

  const bugPayload = {
    ...docs.approvedBug,
    appId: appRef.id,
    releaseId: null,
  };

  const plannedWrites = [
    { path: tenantRef.path, data: docs.tenant },
    { path: appRef.path, data: appPayload },
    { path: counterRef.path, data: docs.counter },
    { path: releaseRef.path, data: releasePayload },
    { path: featureRef.path, data: featurePayload },
    { path: bugRef.path, data: bugPayload },
  ];

  if (dryRun) {
    console.log(`[dry-run] Would upsert isolated test tenant ${config.tenantId}`);
    plannedWrites.forEach(write => console.log(`[dry-run] ${write.path}`, write.data));
    return;
  }

  const batch = db.batch();
  batch.set(tenantRef, docs.tenant, { merge: true });
  batch.set(appRef, appPayload, { merge: true });
  batch.set(counterRef, docs.counter, { merge: true });
  batch.set(releaseRef, releasePayload, { merge: true });
  batch.set(featureRef, featurePayload, { merge: true });
  batch.set(bugRef, bugPayload, { merge: true });
  await batch.commit();

  console.log(`Upserted isolated test tenant ${config.tenantId}`);
  console.log(`App ID: ${appRef.id}`);
  console.log(`Release ID: ${releaseRef.id}`);
  console.log(`Feature suggestion ID: ${featureRef.id}`);
  console.log(`Bug suggestion ID: ${bugRef.id}`);
}

async function collectDocsByTenant(db, collectionName, tenantId) {
  const snapshot = await db.collection(collectionName)
    .where('tenantId', '==', tenantId)
    .get();

  return snapshot.docs;
}

async function deleteTenantData(db, config, dryRun) {
  const collections = [
    'votes',
    'comments',
    'activity',
    'suggestions',
    'releases',
    'userSettings',
    'apps',
  ];

  const docsByCollection = await Promise.all(
    collections.map(async collectionName => ({
      collectionName,
      docs: await collectDocsByTenant(db, collectionName, config.tenantId),
    }))
  );

  const appDocs = docsByCollection.find(entry => entry.collectionName === 'apps')?.docs || [];
  const counterDocs = await Promise.all(
    appDocs.map(appDoc => db.collection('counters').doc(appDoc.id).get())
  );
  const counterDeletes = counterDocs.filter(doc => doc.exists);

  const deleteRefs = [
    ...docsByCollection.flatMap(entry => entry.docs),
    ...counterDeletes,
    await db.collection('tenants').doc(config.tenantId).get(),
  ].filter(doc => doc && doc.exists);

  if (dryRun) {
    console.log(`[dry-run] Would delete isolated test tenant ${config.tenantId}`);
    deleteRefs.forEach(doc => console.log(`[dry-run] delete ${doc.ref.path}`));
    return;
  }

  for (const docs of chunk(deleteRefs)) {
    const batch = db.batch();
    docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
  }

  console.log(`Deleted isolated test tenant ${config.tenantId}`);
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/manage-test-tenant.js create --tenant-slug staging-smoke [--tenant-name "..."] [--app-name "..."] [--app-slug board] [--dry-run]');
  console.log('  node scripts/manage-test-tenant.js delete --tenant-slug staging-smoke --confirm-delete [--dry-run]');
}

async function run() {
  loadDotEnvFileIfPresent();
  const { command, options } = parseArgs(process.argv);

  if (!COMMANDS.has(command)) {
    printUsage();
    throw new Error(`Unsupported command "${command || ''}"`);
  }

  const config = buildSeedConfig(options);
  if (config.tenantId === LEGACY_TENANT_ID) {
    throw new Error('Refusing to manage the legacy tenant as test data.');
  }

  const dryRun = Boolean(options['dry-run']);
  const db = initFirestore();

  if (command === 'create') {
    await ensureCreate(db, config, dryRun);
    return;
  }

  if (!options['confirm-delete']) {
    throw new Error('Deleting a test tenant requires --confirm-delete');
  }

  await deleteTenantData(db, config, dryRun);
}

run().catch(error => {
  console.error('manage-test-tenant failed:', error.message || error);
  process.exit(1);
});
