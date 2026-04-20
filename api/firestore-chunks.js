function chunkValues(values, chunkSize = 10) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }

  const chunks = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }

  return chunks;
}

async function queryCollectionInChunks(db, {
  collectionName,
  fieldName,
  values,
  applyChunkQuery = null,
}) {
  const chunks = chunkValues(values);
  if (chunks.length === 0) {
    return [];
  }

  const snapshots = await Promise.all(
    chunks.map(chunk => {
      let query = db.collection(collectionName).where(fieldName, 'in', chunk);
      if (typeof applyChunkQuery === 'function') {
        query = applyChunkQuery(query, chunk);
      }

      return query.get().catch(() => ({ docs: [] }));
    })
  );

  return snapshots.flatMap(snapshot => snapshot.docs || []);
}

module.exports = {
  chunkValues,
  queryCollectionInChunks,
};
