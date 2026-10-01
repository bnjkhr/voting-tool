const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { matchesQuery, findSimilar, significantTokens } = require('../public/suggestion-search.js');

const suggestions = [
    { id: 'a', type: 'feature', title: 'Dark Mode', description: 'Dunkles Farbschema für die Nacht', votes: 12, ticketNumber: 'GB-12' },
    { id: 'b', type: 'feature', title: 'PDF-Export der Trainingspläne', description: 'Pläne als PDF teilen', votes: 3, labels: ['Export'] },
    { id: 'c', type: 'bug', title: 'Benachrichtigungen kommen doppelt', description: 'Push kommt zweimal an', votes: 0 },
    { id: 'd', type: 'feature', title: 'Kalenderexport', description: 'Termine in den Kalender übernehmen', votes: 7 },
    { id: 'e', type: 'ticket', title: 'Rechnung fehlt', description: 'Ich finde meine Rechnung für Mai nicht', votes: 0 },
];

test('matchesQuery: leere Suche trifft alles', () => {
    assert.equal(matchesQuery(suggestions[0], ''), true);
    assert.equal(matchesQuery(suggestions[0], '   '), true);
});

test('matchesQuery: reagiert schon auf Wortanfänge, ohne Groß-/Kleinschreibung', () => {
    assert.equal(matchesQuery(suggestions[0], 'dar'), true);
    assert.equal(matchesQuery(suggestions[0], 'DARK mo'), true);
    assert.equal(matchesQuery(suggestions[1], 'dark'), false);
});

test('matchesQuery: alle Wörter müssen vorkommen (Titel, Beschreibung, Labels)', () => {
    assert.equal(matchesQuery(suggestions[1], 'pdf teilen'), true);
    assert.equal(matchesQuery(suggestions[1], 'pdf kalender'), false);
    assert.equal(matchesQuery(suggestions[1], 'export'), true);
});

test('matchesQuery: Umlaute und ß werden gleich behandelt', () => {
    assert.equal(matchesQuery(suggestions[3], 'ubernehmen'), true);
    assert.equal(matchesQuery(suggestions[3], 'übernehmen'), true);
    assert.equal(matchesQuery({ title: 'Schriftgröße', description: '' }, 'schriftgrosse'), true);
});

test('matchesQuery: findet Ticketnummern auch ohne Bindestrich', () => {
    assert.equal(matchesQuery(suggestions[0], 'GB-12'), true);
    assert.equal(matchesQuery(suggestions[0], 'gb12'), true);
    assert.equal(matchesQuery(suggestions[1], 'gb12'), false);
});

test('significantTokens: Füllwörter und Kurzwörter fallen raus', () => {
    assert.deepEqual(significantTokens('Ich möchte für den Export bitte ein PDF'), ['export', 'pdf']);
});

test('findSimilar: leerer Entwurf liefert nichts', () => {
    assert.deepEqual(findSimilar(suggestions, {}), []);
    assert.deepEqual(findSimilar(suggestions, { title: 'ich möchte bitte' }), []);
});

test('findSimilar: findet bestehenden Eintrag zum Titel', () => {
    const result = findSimilar(suggestions, { title: 'Dark Mode für die App' });
    assert.equal(result[0].suggestion.id, 'a');
});

test('findSimilar: toleriert Flexion und Komposita', () => {
    const plural = findSimilar(suggestions, { title: 'Doppelte Benachrichtigung' });
    assert.ok(plural.some(r => r.suggestion.id === 'c'), 'Benachrichtigung -> Benachrichtigungen');

    const compound = findSimilar(suggestions, { title: 'Export' });
    const ids = compound.map(r => r.suggestion.id);
    assert.ok(ids.includes('b'), 'PDF-Export');
    assert.ok(ids.includes('d'), 'Kalenderexport');
});

test('findSimilar: Titeltreffer schlagen Beschreibungstreffer, bei Gleichstand mehr Votes zuerst', () => {
    const result = findSimilar(suggestions, { title: 'Export' });
    // b (Titel „PDF-Export", 3 Votes) und d (Titel „Kalenderexport", 7 Votes) treffen beide im Titel.
    assert.deepEqual(result.map(r => r.suggestion.id), ['d', 'b']);
});

test('findSimilar: greift auf die Beschreibung zurück, wenn der Titel nichts hergibt', () => {
    const result = findSimilar(suggestions, {
        title: '',
        description: 'Meine Rechnung für Mai ist nicht auffindbar',
    });
    assert.equal(result[0]?.suggestion.id, 'e');
});

test('findSimilar: unpassende Einträge werden nicht vorgeschlagen', () => {
    assert.deepEqual(findSimilar(suggestions, { title: 'Sprachsteuerung per Siri' }), []);
});

test('findSimilar: respektiert das Limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: String(i), title: `Export ${i}`, description: '' }));
    assert.equal(findSimilar(many, { title: 'Export' }, { limit: 3 }).length, 3);
});

test('index.html lädt suggestion-search.js root-relativ vor script.js', () => {
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
    const searchPos = indexHtml.indexOf('src="/suggestion-search.js"');
    const scriptPos = indexHtml.indexOf('src="/script.js"');
    assert.ok(searchPos > -1, 'suggestion-search.js fehlt');
    assert.ok(searchPos < scriptPos, 'suggestion-search.js muss vor script.js geladen werden');
});
