'use strict';

// Startet die echte Express-App mit Firestore und Mailversand im Arbeitsspeicher:
// kein Netz, keine Zugangsdaten. Vor dem ersten require von api/index.js laden.
const path = require('node:path');

const rootDir = path.join(__dirname, '..');

// Leer gesetzte Variablen überschreibt der .env-Lader der App nicht.
Object.assign(process.env, {
  DATA_BACKEND: '',
  DATABASE_URL: '',
  VERCEL_ENV: '',
  STRIPE_SECRET_KEY: '',
  RESEND_API_KEY: 're_test',
  BASE_URL: 'http://localhost',
  ADMIN_PASSWORD: 'test-admin-password',
  OPERATOR_EMAIL: 'operator@example.test',
});

const collections = new Map();
const sentMails = [];
let nextId = 0;

function records(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

function docRef(name, id) {
  const ref = {
    id,
    async get() {
      const stored = records(name).get(id);
      return { id, ref, exists: Boolean(stored), data: () => (stored ? { ...stored } : undefined) };
    },
    async set(data, options = {}) {
      records(name).set(id, options.merge ? { ...records(name).get(id), ...data } : { ...data });
    },
    async update(data) {
      records(name).set(id, { ...records(name).get(id), ...data });
    },
    async delete() {
      records(name).delete(id);
    },
  };
  return ref;
}

function query(name, filters = [], max = Infinity) {
  return {
    where: (field, op, value) => query(name, [...filters, { field, op, value }], max),
    limit: (count) => query(name, filters, count),
    orderBy: () => query(name, filters, max),
    async get() {
      const matches = [...records(name).entries()]
        .filter(([, data]) => filters.every(({ field, op, value }) => (
          op === 'in' ? value.includes(data[field]) : data[field] === value
        )))
        .slice(0, max);
      const docs = await Promise.all(matches.map(([id]) => docRef(name, id).get()));
      return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
    },
  };
}

const db = {
  collection: (name) => ({
    ...query(name),
    doc: (id = `auto${++nextId}`) => docRef(name, id),
    async add(data) {
      const ref = docRef(name, `auto${++nextId}`);
      await ref.set(data);
      return ref;
    },
  }),
  runTransaction: (fn) => fn({
    get: (target) => target.get(),
    set: (ref, data, options) => ref.set(data, options),
  }),
};

function stubModule(name, exports) {
  const file = require.resolve(name, { paths: [rootDir] });
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

stubModule('firebase-admin', {
  apps: [{}],
  firestore: Object.assign(() => db, {
    FieldValue: { serverTimestamp: () => new Date() },
  }),
});

stubModule('resend', {
  Resend: class {
    constructor() {
      this.emails = {
        send: async (mail) => {
          sentMails.push(mail);
          return { data: { id: 'mail' }, error: null };
        },
      };
    }
  },
});

function seed(name, id, data) {
  records(name).set(id, { ...data });
}

function reset() {
  collections.clear();
  sentMails.length = 0;
}

let clientCounter = 0;

async function startApp() {
  const app = require('../api/index.js');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(urlPath, { method = 'GET', body, headers = {} } = {}) {
    // Jede Anfrage bekommt eine eigene Client-Adresse, damit das Rate-Limit nicht greift.
    clientCounter += 1;
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': `198.51.100.${clientCounter}`,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  }

  const close = () => new Promise((resolve) => server.close(resolve));
  return { request, close };
}

module.exports = { records, reset, seed, sentMails, startApp };
