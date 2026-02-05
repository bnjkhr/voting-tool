// Firebase initialization script - can be re-run safely to ensure default apps exist
const admin = require('firebase-admin');

// Initialize Firebase Admin (make sure to set environment variables)
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});

const db = admin.firestore();

async function ensureDefaultApps() {
  const defaultApps = [
    {
      name: 'GymBo',
      description: 'Fitness-Tracking und Workout-Planung'
    },
    {
      name: 'FamilyManager',
      description: 'Familienorganisation, Aufgaben und Alltagsplanung'
    }
  ];

  console.log('Ensuring default apps exist...');

  for (const app of defaultApps) {
    try {
      const existing = await db.collection('apps')
        .where('name', '==', app.name)
        .limit(1)
        .get();

      if (!existing.empty) {
        console.log(`↩︎ App already exists: ${app.name} (ID: ${existing.docs[0].id})`);
        continue;
      }

      const docRef = await db.collection('apps').add(app);
      console.log(`✅ Created app: ${app.name} (ID: ${docRef.id})`);
    } catch (error) {
      console.error(`❌ Error creating app ${app.name}:`, error);
    }
  }

  console.log('Default apps ensured.');
  process.exit(0);
}

async function run() {
  try {
    await ensureDefaultApps();
  } catch (error) {
    console.error('Error checking apps:', error);
    process.exit(1);
  }
}

run();
