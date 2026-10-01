(function initSuggestionSearch(globalScope) {
    // Rein lexikalische Suche über die bereits geladenen Einträge eines Boards.
    // Läuft komplett im Browser, damit sie bei jedem Tastendruck reagieren kann,
    // ohne pro Eingabe einen Request zu schicken. Sie versteht keine Synonyme
    // („Dunkelmodus" findet „Dark Mode" nicht), fängt aber Groß-/Kleinschreibung,
    // Umlaute, Flexion („Benachrichtigung"/„Benachrichtigungen") und Komposita
    // („Export" in „Kalenderexport") ab.

    // Füllwörter, die beim Ähnlichkeitsvergleich nichts aussagen. Bei der
    // Listen-Suche bleiben sie erlaubt, dort tippt man gezielt.
    const STOPWORD_LIST = [
        'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
        'und', 'oder', 'aber', 'auch', 'noch', 'nur', 'schon', 'sehr', 'mehr', 'mal',
        'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr', 'man', 'mich', 'mir', 'dich', 'dir', 'uns',
        'mein', 'meine', 'dein', 'deine', 'sein', 'seine', 'unser', 'unsere',
        'ist', 'sind', 'war', 'waere', 'wäre', 'wird', 'werden', 'wurde', 'hat', 'haben', 'hatte',
        'kann', 'koennen', 'können', 'soll', 'sollte', 'muss', 'moechte', 'möchte', 'will', 'wuerde', 'würde',
        'mit', 'von', 'vom', 'zu', 'zum', 'zur', 'auf', 'aus', 'bei', 'beim', 'fuer', 'für', 'nach',
        'ueber', 'über', 'unter', 'vor', 'im', 'in', 'an', 'am', 'als', 'wie', 'wenn', 'dass', 'damit',
        'nicht', 'kein', 'keine', 'bitte', 'gibt', 'geht', 'neue', 'neuer', 'neues', 'neuen',
        'the', 'and', 'for', 'with', 'not', 'please', 'add', 'new',
    ];

    function normalizeText(text) {
        return String(text == null ? '' : text)
            .toLowerCase()
            .replace(/ß/g, 'ss')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '');
    }

    // Gleich normalisiert wie die Eingabe, sonst bliebe „für“ (-> „fur“) stehen.
    const STOPWORDS = new Set(STOPWORD_LIST.map(normalizeText));

    function tokenize(text) {
        return normalizeText(text).split(/[^a-z0-9]+/).filter(Boolean);
    }

    function significantTokens(text) {
        const seen = new Set();
        return tokenize(text).filter(token => {
            if (token.length < 3 || STOPWORDS.has(token) || seen.has(token)) return false;
            seen.add(token);
            return true;
        });
    }

    // Toleriert Flexion und Komposita: „export" trifft „kalenderexport",
    // „benachrichtigung" trifft „benachrichtigungen", „sync" trifft „synchronisierung".
    function tokensMatch(queryToken, docToken) {
        if (queryToken === docToken) return true;
        if (docToken.startsWith(queryToken)) return true;
        if (docToken.length >= 4 && queryToken.startsWith(docToken)) return true;
        if (queryToken.length >= 5 && docToken.includes(queryToken)) return true;
        const prefix = 5;
        return queryToken.length >= prefix && docToken.length >= prefix
            && queryToken.slice(0, prefix) === docToken.slice(0, prefix)
            && Math.abs(queryToken.length - docToken.length) <= 3;
    }

    function hasMatch(queryToken, docTokens) {
        return docTokens.some(docToken => tokensMatch(queryToken, docToken));
    }

    function searchableFields(suggestion) {
        return {
            title: tokenize(suggestion.title),
            description: tokenize(suggestion.description),
            meta: tokenize([
                suggestion.ticketNumber,
                ...(Array.isArray(suggestion.labels) ? suggestion.labels : []),
            ].filter(Boolean).join(' ')),
        };
    }

    // Listen-Suche: jedes eingegebene Wort muss irgendwo im Eintrag vorkommen
    // (Titel, Beschreibung, Ticketnummer oder Label). Wortanfänge reichen, damit
    // die Liste schon beim Tippen sinnvoll reagiert.
    function matchesQuery(suggestion, query) {
        const queryTokens = tokenize(query);
        if (queryTokens.length === 0) return true;

        const fields = searchableFields(suggestion);
        const allTokens = [...fields.title, ...fields.description, ...fields.meta];
        const ticketNumber = normalizeText(suggestion.ticketNumber).replace(/[^a-z0-9]/g, '');
        const compactQuery = normalizeText(query).replace(/[^a-z0-9]/g, '');

        if (ticketNumber && compactQuery && ticketNumber.startsWith(compactQuery)) return true;

        return queryTokens.every(queryToken =>
            allTokens.some(docToken => docToken.startsWith(queryToken) || docToken.includes(queryToken))
        );
    }

    // Anteil der Suchwörter, die im Eintrag vorkommen. Treffer im Titel zählen
    // voll, Treffer nur in Beschreibung/Labels halb.
    function scoreTokens(queryTokens, fields) {
        if (queryTokens.length === 0) return 0;
        const bodyTokens = [...fields.description, ...fields.meta];
        let points = 0;
        queryTokens.forEach(queryToken => {
            if (hasMatch(queryToken, fields.title)) points += 1;
            else if (hasMatch(queryToken, bodyTokens)) points += 0.5;
        });
        return points / queryTokens.length;
    }

    const MIN_SIMILARITY = 0.34;

    // Ähnliche Einträge zum Formular-Entwurf. Der Titel ist das stärkste Signal;
    // die Beschreibung zählt mit, falls der Titel noch leer oder sehr knapp ist.
    function findSimilar(suggestions, draft = {}, { limit = 5, minScore = MIN_SIMILARITY } = {}) {
        const titleTokens = significantTokens(draft.title);
        const descriptionTokens = significantTokens(draft.description).slice(0, 30);
        if (titleTokens.length === 0 && descriptionTokens.length === 0) return [];

        return (Array.isArray(suggestions) ? suggestions : [])
            .map(suggestion => {
                const fields = searchableFields(suggestion);
                const titleScore = scoreTokens(titleTokens, fields);
                // Lange Beschreibungen erzeugen viele Wörter, die nirgends vorkommen.
                // Darum zählt dort schon ein Drittel Überdeckung als Treffer, aber
                // gedämpft, damit der Titel Vorrang hat.
                const descriptionScore = Math.min(1, scoreTokens(descriptionTokens, fields) * 2) * 0.7;
                return { suggestion, score: Math.max(titleScore, descriptionScore) };
            })
            .filter(result => result.score >= minScore)
            .sort((a, b) => (b.score - a.score)
                || ((b.suggestion.votes || 0) - (a.suggestion.votes || 0)))
            .slice(0, limit);
    }

    const api = { normalizeText, tokenize, significantTokens, matchesQuery, findSimilar };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    globalScope.SuggestionSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
