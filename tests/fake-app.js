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

// Gelesene Sammlungen in Reihenfolge, und gestörte Sammlungen.
const readLog = [];
const brokenReads = new Map();

// Lässt jedes Lesen der Sammlung scheitern, mit `hang` hängen. Gibt die
// Funktion zurück, die die Störung wieder aufhebt.
function failReads(name, { hang = false } = {}) {
  brokenReads.set(name, hang);
  return () => brokenReads.delete(name);
}

async function noteRead(name) {
  readLog.push(name);
  if (!brokenReads.has(name)) return;
  if (brokenReads.get(name)) await new Promise(() => {});
  throw new Error(`Lesen von „${name}“ ist gestört`);
}

function records(name) {
  if (!collections.has(name)) collections.set(name, new Map());
  return collections.get(name);
}

class Increment {
  constructor(amount) {
    this.amount = amount;
  }
}

function applyUpdate(stored = {}, data) {
  const next = { ...stored };
  for (const [field, value] of Object.entries(data)) {
    next[field] = value instanceof Increment ? (stored[field] || 0) + value.amount : value;
  }
  return next;
}

function docRef(name, id) {
  const ref = {
    id,
    async get() {
      await noteRead(name);
      const stored = records(name).get(id);
      return { id, ref, exists: Boolean(stored), data: () => (stored ? { ...stored } : undefined) };
    },
    async set(data, options = {}) {
      records(name).set(id, options.merge ? { ...records(name).get(id), ...data } : { ...data });
    },
    async update(data) {
      records(name).set(id, applyUpdate(records(name).get(id), data));
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
      await noteRead(name);
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
  batch() {
    const writes = [];
    return {
      set: (ref, data, options) => writes.push(() => ref.set(data, options)),
      create: (ref, data) => writes.push(async () => {
        if ((await ref.get()).exists) throw new Error(`Dokument existiert bereits: ${ref.id}`);
        await ref.set(data);
      }),
      update: (ref, data) => writes.push(() => ref.update(data)),
      delete: (ref) => writes.push(() => ref.delete()),
      async commit() {
        for (const write of writes) await write();
      },
    };
  },
};

function stubModule(name, exports) {
  const file = require.resolve(name, { paths: [rootDir] });
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

stubModule('firebase-admin', {
  apps: [{}],
  firestore: Object.assign(() => db, {
    FieldValue: {
      serverTimestamp: () => new Date(),
      increment: (amount) => new Increment(amount),
    },
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

// Gesamter Datenbestand, um unerwünschte Schreibzugriffe zu erkennen.
function dump() {
  return Object.fromEntries([...collections]
    .filter(([, stored]) => stored.size > 0)
    .map(([name, stored]) => [name, Object.fromEntries(stored)]));
}

function reset() {
  collections.clear();
  sentMails.length = 0;
  readLog.length = 0;
  brokenReads.clear();
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
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // HTML-Antworten bleiben nur als Text verfügbar.
    }
    return { status: response.status, text, body: json };
  }

  const close = () => new Promise((resolve) => server.close(resolve));
  return { request, close };
}

module.exports = { dump, failReads, readLog, records, reset, seed, sentMails, startApp };
