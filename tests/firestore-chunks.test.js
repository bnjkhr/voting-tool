const test = require('node:test');
const assert = require('node:assert/strict');

const { chunkValues, queryCollectionInChunks } = require('../api/firestore-chunks');

test('chunkValues splits values into Firestore-safe groups of ten', () => {
  const values = Array.from({ length: 23 }, (_, idx) => `suggestion-${idx + 1}`);

  assert.deepEqual(
    chunkValues(values),
    [
      values.slice(0, 10),
      values.slice(10, 20),
      values.slice(20, 23),
    ]
  );
});

test('queryCollectionInChunks queries every chunk and combines the docs', async () => {
  const seenChunks = [];
  const docsByChunk = new Map([
    ['alpha,beta,gamma,delta,epsilon,zeta,eta,theta,iota,kappa', [{ id: 'c-1' }]],
    ['lambda,mu', [{ id: 'c-2' }, { id: 'c-3' }]],
  ]);

  const db = {
    collection(collectionName) {
      assert.equal(collectionName, 'comments');
      return {
        where(fieldName, operator, chunk) {
          assert.equal(fieldName, 'suggestionId');
          assert.equal(operator, 'in');
          seenChunks.push(chunk);

          return {
            get: async () => ({
              docs: docsByChunk.get(chunk.join(',')) || [],
            }),
          };
        },
      };
    },
  };

  const docs = await queryCollectionInChunks(db, {
    collectionName: 'comments',
    fieldName: 'suggestionId',
    values: [
      'alpha', 'beta', 'gamma', 'delta', 'epsilon',
      'zeta', 'eta', 'theta', 'iota', 'kappa',
      'lambda', 'mu',
    ],
  });

  assert.deepEqual(seenChunks, [
    ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa'],
    ['lambda', 'mu'],
  ]);
  assert.deepEqual(docs, [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }]);
});

test('queryCollectionInChunks applies extra query constraints to each chunk', async () => {
  const seenFingerprints = [];

  const db = {
    collection() {
      return {
        where(fieldName, operator, chunk) {
          assert.equal(fieldName, 'suggestionId');
          assert.equal(operator, 'in');
          assert.deepEqual(chunk, ['suggestion-1']);

          return {
            where(extraField, extraOperator, value) {
              seenFingerprints.push({ extraField, extraOperator, value });
              return {
                get: async () => ({ docs: [{ id: 'vote-1' }] }),
              };
            },
          };
        },
      };
    },
  };

  const docs = await queryCollectionInChunks(db, {
    collectionName: 'votes',
    fieldName: 'suggestionId',
    values: ['suggestion-1'],
    applyChunkQuery: query => query.where('userFingerprint', '==', 'fingerprint-123'),
  });

  assert.deepEqual(seenFingerprints, [{
    extraField: 'userFingerprint',
    extraOperator: '==',
    value: 'fingerprint-123',
  }]);
  assert.deepEqual(docs, [{ id: 'vote-1' }]);
});
