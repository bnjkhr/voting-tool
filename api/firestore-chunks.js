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

// Firestore begrenzt einen Batch auf 500 Schreibvorgaenge; mit Puffer.
const DELETE_CHUNK = 400;

// `throwOnError` ist bewusst opt-in: die bestehenden Lesepfade degradieren bei
// einem transienten Fehler zu einer ungenauen Zahl, was dort hinnehmbar ist.
// Auf einem LOESCHPFAD ist dasselbe Verhalten Datenverlust — ein Fehler laesst
// Kinder als nicht vorhanden erscheinen, das Elternteil wird geloescht, die
// Kinder sind danach nicht mehr auffindbar. Solche Aufrufer setzen das Flag.
async function queryCollectionInChunks(db, {
  collectionName,
  fieldName,
  values,
  applyChunkQuery = null,
  throwOnError = false,
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

      if (throwOnError) return query.get();
      return query.get().catch(() => ({ docs: [] }));
    })
  );

  return snapshots.flatMap(snapshot => snapshot.docs || []);
}

// Loescht Dokumente in begrenzten, sequenziellen Batches. Nimmt Snapshots oder
// Refs entgegen, damit projizierte Ergebnisse (siehe .select()) direkt
// durchgereicht werden koennen. Sequenziell statt Promise.all, damit der
// Schreibdurchsatz beschraenkt bleibt.
async function deleteDocsInChunks(db, docs) {
  const refs = (docs || []).map(doc => doc && doc.ref).filter(Boolean);
  for (let i = 0; i < refs.length; i += DELETE_CHUNK) {
    const batch = db.batch();
    refs.slice(i, i + DELETE_CHUNK).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
  return refs.length;
}

module.exports = {
  chunkValues,
  deleteDocsInChunks,
  queryCollectionInChunks,
};
