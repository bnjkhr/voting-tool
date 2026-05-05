const {
  buildTenantProvisionConfig,
  buildTenantProvisionDocuments,
} = require('../api/tenant-provisioning');
const {
  admin,
  initFirestore,
  loadDotEnvFileIfPresent,
} = require('./firebase-admin-utils');

function parseArgs(argv) {
  const options = {};

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      options[key] = true;
      continue;
    }

    options[key] = next;
    i += 1;
  }

  return options;
}

async function assertTenantIsAvailable(db, config) {
  const tenantRef = db.collection('tenants').doc(config.tenantId);
  const tenantDoc = await tenantRef.get();
  if (tenantDoc.exists) {
    throw new Error(`Tenant "${config.tenantId}" already exists.`);
  }

  const slugSnapshot = await db.collection('tenants')
    .where('slug', '==', config.tenantSlug)
    .limit(1)
    .get();

  if (!slugSnapshot.empty) {
    throw new Error(`Tenant slug "${config.tenantSlug}" is already used.`);
  }
}

async function createTenant(db, rawOptions) {
  const dryRun = Boolean(rawOptions['dry-run']);
  const config = buildTenantProvisionConfig({
    tenantName: rawOptions['tenant-name'],
    tenantSlug: rawOptions['tenant-slug'],
    appName: rawOptions['app-name'],
    appSlug: rawOptions['app-slug'],
    ticketPrefix: rawOptions['ticket-prefix'],
  });

  await assertTenantIsAvailable(db, config);

  const timestamp = admin.firestore.FieldValue.serverTimestamp();
  const docs = buildTenantProvisionDocuments(config, timestamp);
  const tenantRef = db.collection('tenants').doc(config.tenantId);
  const appRef = db.collection('apps').doc();
  const counterRef = db.collection('counters').doc(appRef.id);

  const plannedWrites = [
    { path: tenantRef.path, data: docs.tenant },
    { path: appRef.path, data: docs.app },
    { path: counterRef.path, data: docs.counter },
  ];

  if (dryRun) {
    console.log(`[dry-run] Would create tenant ${config.tenantId}`);
    plannedWrites.forEach(write => console.log(`[dry-run] ${write.path}`, write.data));
    return { config, appId: appRef.id, dryRun };
  }

  const batch = db.batch();
  batch.create(tenantRef, docs.tenant);
  batch.create(appRef, docs.app);
  batch.create(counterRef, docs.counter);
  await batch.commit();

  console.log(`Created tenant ${config.tenantId}`);
  console.log(`App ID: ${appRef.id}`);
  console.log(`Public URL: /?tenant=${config.tenantSlug}&app=${config.appSlug}`);
  console.log(`Tenant Admin URL: /tenant-admin.html?tenant=${config.tenantSlug}`);

  return { config, appId: appRef.id, dryRun };
}

async function run() {
  loadDotEnvFileIfPresent();
  const db = initFirestore();
  const options = parseArgs(process.argv);

  if (!options['tenant-name'] && !options['tenant-slug']) {
    throw new Error('Missing --tenant-name or --tenant-slug');
  }

  await createTenant(db, options);
}

if (require.main === module) {
  run().catch(error => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = {
  createTenant,
  parseArgs,
};
