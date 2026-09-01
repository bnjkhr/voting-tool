'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');

test('Firebase Admin exposes the namespace API used by the production function', () => {
  assert.ok(Array.isArray(admin.apps));
  assert.equal(typeof admin.initializeApp, 'function');
  assert.equal(typeof admin.credential?.cert, 'function');
  assert.equal(typeof admin.credential?.applicationDefault, 'function');
  assert.equal(typeof admin.firestore, 'function');
  assert.equal(typeof admin.firestore.FieldValue.serverTimestamp, 'function');
});
