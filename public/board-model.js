(function initBoardModel(globalScope) {
    // Zuordnung, Sortierung und Texte fürs Kanban-Board der Konsole. Reine
    // Funktionen: kein DOM, kein Netz, die Eingabe bleibt unverändert.

    const COLUMNS = [
        { key: 'offen', label: 'Offen' },
        { key: 'arbeit', label: 'In Arbeit' },
        { key: 'test', label: 'Im Test' },
        { key: 'wartet', label: 'Wartet' },
        { key: 'fertig', label: 'Fertig' },
    ];

    // Welche Status eine Spalte zeigt. Der erste ist der, den Ablegen setzt.
    const TICKET_COLUMNS = {
        offen: ['offen', 'neu'],
        arbeit: ['in Bearbeitung'],
        test: ['im Test'],
        wartet: ['wartend'],
        fertig: ['gelöst'],
    };
    // Features kennen kein „Wartet“.
    const FEATURE_COLUMNS = {
        offen: ['wird geprüft', 'neu'],
        arbeit: ['wird umgesetzt'],
        test: ['im Test'],
        fertig: ['ist umgesetzt'],
    };

    const HIDDEN_STATUSES = ['geschlossen', 'wird nicht umgesetzt'];
    const PRIORITY_ORDER = ['kritisch', 'hoch', 'mittel', 'niedrig'];
    const DONE_LIMIT = 20;

    function columnsForType(type) {
        return type === 'feature' ? FEATURE_COLUMNS : TICKET_COLUMNS;
    }

    // null: Der Eintrag gehört nicht aufs Board. Nicht freigegebene fehlen
    // bewusst, denn jeder Statuswechsel würde sie nebenbei freigeben. Ein
    // unbekannter Status landet in „Offen“, damit nichts verschwindet.
    function columnFor(item) {
        if (!item.approved || HIDDEN_STATUSES.includes(item.status)) return null;
        const match = Object.entries(columnsForType(item.type))
            .find(([, statuses]) => statuses.includes(item.status));
        return match ? match[0] : 'offen';
    }

    function statusFor(columnKey, type) {
        const columns = columnsForType(type);
        return Object.hasOwn(columns, columnKey) ? columns[columnKey][0] : null;
    }

    // Wer von außen eingereicht hat, kann beim Statuswechsel eine Mail bekommen.
    // Ohne Rückfrage bleiben nur Einträge, die sicher per API angelegt wurden.
    function needsConfirm(item) {
        return Boolean(item.notificationEnabled)
            || !String(item.userFingerprint || '').startsWith('api:');
    }

    function priorityRank(item) {
        const rank = PRIORITY_ORDER.indexOf(item.priority);
        return rank === -1 ? PRIORITY_ORDER.indexOf('mittel') : rank;
    }

    function compareCards(a, b) {
        const byPriority = priorityRank(a) - priorityRank(b);
        if (byPriority !== 0) return byPriority;
        // Ohne Ticketnummer ans Ende.
        if (!a.ticketNumber || !b.ticketNumber) {
            return Number(!a.ticketNumber) - Number(!b.ticketNumber);
        }
        return String(a.ticketNumber).localeCompare(String(b.ticketNumber), 'de', { numeric: true });
    }

    // Postgres liefert ISO-Texte, Firestore { _seconds } bzw. { seconds }.
    function timeOf(value) {
        if (!value) return 0;
        const seconds = value._seconds ?? value.seconds;
        const time = seconds === undefined ? new Date(value).getTime() : seconds * 1000;
        return Number.isNaN(time) ? 0 : time;
    }

    function finishedAt(item) {
        return timeOf(item.tagUpdatedAt || item.createdAt);
    }

    function buildBoard(items, { appId = '', label = '' } = {}) {
        const matching = items.filter(item => (!appId || item.appId === appId)
            && (!label || (item.labels || []).includes(label)));

        const columns = {};
        COLUMNS.forEach(({ key }) => {
            const cards = matching.filter(item => columnFor(item) === key);
            const items = key === 'fertig'
                // Die letzten Erledigten, neueste zuerst.
                ? cards.sort((a, b) => finishedAt(b) - finishedAt(a) || compareCards(a, b)).slice(0, DONE_LIMIT)
                : cards.sort(compareCards);
            columns[key] = { items, total: cards.length };
        });

        return {
            columns,
            pendingCount: matching.filter(item => !item.approved).length,
            // Aus allen Einträgen, sonst schrumpft die Auswahl auf das gewählte Label.
            labels: [...new Set(items.flatMap(item => item.labels || []))]
                .sort((a, b) => String(a).localeCompare(String(b), 'de')),
        };
    }

    // Nur https und Pfade auf dem eigenen Server. Steuerzeichen und
    // Backslashes fallen weg, weil der Browser daraus eine fremde Adresse macht.
    function safeUrl(url) {
        const text = typeof url === 'string' ? url : '';
        if (/[\u0000- \u007f\\]/.test(text)) return null;
        return /^(https:\/\/|\/(?!\/))/i.test(text) ? text : null;
    }

    // Zeile auf der Karte zum verknüpften öffentlichen Eintrag. Ein Link nur,
    // wo es dort etwas zu sehen gibt.
    function publicLine(link) {
        if (!link) return null;
        const line = (state, url = null) => ({ text: `Öffentlich: ${state}`, url });
        // Nie gesehen und trotzdem „fehlt“: meist eine vertippte ID.
        if (link.publicDeleted) return line(link.publicSeenAt ? 'gelöscht' : 'nicht gefunden');
        if (!link.publicSeenAt) return line('noch nicht geholt');
        if (link.publicApproved === false) return line('nicht freigegeben');
        return line(link.publicStatus || 'unbekannt', safeUrl(link.url));
    }

    // Wie viele öffentliche Einträge je Quelle auf Freigabe warten.
    function unapprovedSummary(sources) {
        const waiting = sources.filter(source => source.unapprovedCount > 0);
        const total = waiting.reduce((sum, source) => sum + source.unapprovedCount, 0);
        if (total === 0) return '';
        const head = total === 1
            ? 'Öffentlich wartet 1 Eintrag auf Freigabe'
            : `Öffentlich warten ${total} Einträge auf Freigabe`;
        return `${head}: ${waiting.map(source => `${source.boardName} ${source.unapprovedCount}`).join(', ')}.`;
    }

    const api = {
        COLUMNS, columnFor, statusFor, needsConfirm, buildBoard, publicLine, unapprovedSummary,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    globalScope.BoardModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
