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
  EMAIL_FROM: '',
  LEGACY_EMAIL_FROM: '',
  BASE_URL: 'http://localhost',
  ADMIN_PASSWORD: 'test-admin-password',
  OPERATOR_EMAIL: 'operator@example.test',
});

const collections = new Map();
const sentMails = [];
let nextId = 0;

// Gelesene Sammlungen in Reihenfolge, Schreibzugriffe je Sammlung und
// Dokument, und gestörte Sammlungen.
const readLog = [];
const writeLog = [];
// Jeder begonnene Schreibzugriff, auch ein hängender oder abgelehnter.
const writeAttempts = [];
const brokenReads = new Map();
const brokenWrites = new Map();
let mailFailure = null;

// Lässt jedes Lesen (Schreiben) der Sammlung scheitern. Mit `hang: true` hängt
// es für immer; mit einem Versprechen hängt es, bis dieses erfüllt ist, und
// läuft dann normal weiter. Gibt die Funktion zurück, die die Störung wieder
// aufhebt.
const disturb = (broken) => (name, { hang = false } = {}) => {
  broken.set(name, hang);
  return () => broken.delete(name);
};
const failReads = disturb(brokenReads);
const failWrites = disturb(brokenWrites);

// Jeder weitere Mailversand scheitert: Ein `Error` wird geworfen, alles andere
// meldet Resend als `error` zurück.
function failMails(error) {
  mailFailure = error;
  return () => { mailFailure = null; };
}

async function pass(broken, name, what) {
  if (!broken.has(name)) return;
  const hang = broken.get(name);
  if (hang === true) await new Promise(() => {});
  if (hang) await hang;
  else throw new Error(`${what} von „${name}“ ist gestört`);
}

async function noteRead(name) {
  readLog.push(name);
  await pass(brokenReads, name, 'Lesen');
}

async function write(collection, id, op, apply) {
  writeAttempts.push({ collection, id, op });
  await pass(brokenWrites, collection, 'Schreiben');
  apply();
  writeLog.push({ collection, id, op });
}

// `updateTime` wie bei Firestore: Jeder Schreibzugriff legt ein neues Objekt ab
// und damit einen neuen Stand.
class Timestamp {
  constructor(sequence) {
    this.sequence = sequence;
  }
}
const updateTimes = new WeakMap();
const hiddenUpdateTimes = new Set();
let sequence = 0;

function updateTimeOf(stored) {
  if (!updateTimes.has(stored)) updateTimes.set(stored, new Timestamp(sequence += 1));
  return updateTimes.get(stored);
}

// Snapshots der Sammlung kommen ohne `updateTime`.
function hideUpdateTime(name) {
  hiddenUpdateTimes.add(name);
  return () => hiddenUpdateTimes.delete(name);
}

// Die Vorbedingung von update(), geprüft erst beim Anwenden: Was inzwischen
// geschrieben wurde, zählt. Wie die Bibliothek prüft `{ lastUpdateTime:
// undefined }` nichts.
function checkPrecondition(name, id, precondition) {
  const lastUpdateTime = precondition?.lastUpdateTime;
  if (lastUpdateTime === undefined) return;
  if (!(lastUpdateTime instanceof Timestamp)) {
    throw new Error('"lastUpdateTime" is not a Firestore Timestamp.');
  }
  const stored = records(name).get(id);
  if (!stored) throw Object.assign(new Error('5 NOT_FOUND: Dokument fehlt'), { code: 5 });
  if (updateTimeOf(stored) !== lastUpdateTime) {
    throw Object.assign(new Error('9 FAILED_PRECONDITION: Dokument wurde geändert'), { code: 9 });
  }
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
      return {
        id,
        ref,
        exists: Boolean(stored),
        updateTime: stored && !hiddenUpdateTimes.has(name) ? updateTimeOf(stored) : undefined,
        data: () => (stored ? { ...stored } : undefined),
      };
    },
    set: (data, options = {}) => write(name, id, 'set', () => {
      records(name).set(id, options.merge ? { ...records(name).get(id), ...data } : { ...data });
    }),
    update: (data, precondition) => write(name, id, 'update', () => {
      checkPrecondition(name, id, precondition);
      records(name).set(id, applyUpdate(records(name).get(id), data));
    }),
    delete: () => write(name, id, 'delete', () => records(name).delete(id)),
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
      update: (ref, data, precondition) => writes.push(() => ref.update(data, precondition)),
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
          // `sentMails` zählt jeden Versuch, auch einen gescheiterten.
          sentMails.push(mail);
          if (mailFailure instanceof Error) throw mailFailure;
          if (mailFailure) return { data: null, error: mailFailure };
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
  writeLog.length = 0;
  writeAttempts.length = 0;
  hiddenUpdateTimes.clear();
  brokenReads.clear();
  brokenWrites.clear();
  mailFailure = null;
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

module.exports = {
  dump, failMails, failReads, failWrites, hideUpdateTime, readLog, records, reset, seed, sentMails, startApp,
  writeAttempts, writeLog,
};
