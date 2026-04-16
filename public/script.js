class VotingApp {
    static TAG_STYLES = {
        // Feature statuses
        'wird umgesetzt':       { color: '#3b82f6', icon: '\u2713' },
        'ist umgesetzt':        { color: '#059669', icon: '\u2713\u2713' },
        'umgesetzt':            { color: '#059669', icon: '\u2713\u2713' },
        'wird nicht umgesetzt': { color: '#ef4444', icon: '\u2717' },
        'wird gepr\u00fcft':    { color: '#f59e0b', icon: '\u231B' },
        // Legacy bug tags
        'neu':                  { color: '#ef4444', icon: '\uD83D\uDC1E' },
        'in analyse':           { color: '#f59e0b', icon: '\uD83D\uDD0E' },
        'behoben':              { color: '#10b981', icon: '\u2713' },
        'nicht reproduzierbar': { color: '#64748b', icon: '\u2205' },
        // Ticket/Bug statuses
        'offen':                { color: '#3b82f6', icon: '\u25CB' },
        'in Bearbeitung':       { color: '#f59e0b', icon: '\u231B' },
        'wartend':              { color: '#a855f7', icon: '\u23F8' },
        'gel\u00f6st':          { color: '#10b981', icon: '\u2713' },
        'geschlossen':          { color: '#64748b', icon: '\u2717' },
    };

    static PRIORITY_STYLES = {
        'niedrig':  { color: '#3b82f6', label: 'Niedrig' },
        'mittel':   { color: '#f59e0b', label: 'Mittel' },
        'hoch':     { color: '#f97316', label: 'Hoch' },
        'kritisch': { color: '#ef4444', label: 'Kritisch' },
    };

    static RESOLVED_STATUSES = ['ist umgesetzt', 'wird nicht umgesetzt', 'gelöst', 'geschlossen'];

    static DEFAULT_TAG_STYLE = { color: '#64748b', icon: '\u2022' };

    constructor() {
        this.apps = [];
        this.currentApp = null;
        this.votedSuggestions = new Set(this.getVotedSuggestions());
        this.currentFilter = 'all';
        this.currentView = 'suggestions';
        this.allSuggestions = [];
        this.currentReportType = 'feature';
        this.bugScreenshots = [];
        this.init();
    }

    init() {
        this.initDarkMode();
        this.bindEvents();
        this.loadApps();
    }

    initDarkMode() {
        const saved = localStorage.getItem('theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const isDark = saved ? saved === 'dark' : prefersDark;
        this.applyTheme(isDark ? 'dark' : 'light');
    }

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.setAttribute('content', theme === 'dark' ? '#0F0F0F' : '#FFFFFF');

        const isDark = theme === 'dark';
        const sunSvg = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <circle cx="12" cy="12" r="5"/>
                 <line x1="12" y1="1" x2="12" y2="3"/>
                 <line x1="12" y1="21" x2="12" y2="23"/>
                 <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                 <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                 <line x1="1" y1="12" x2="3" y2="12"/>
                 <line x1="21" y1="12" x2="23" y2="12"/>
                 <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                 <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
               </svg>`;
        const moonSvg = `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
               </svg>`;
        const icon = isDark ? sunSvg : moonSvg;
        const label = isDark ? 'Light Mode aktivieren' : 'Dark Mode aktivieren';

        document.querySelectorAll('#themeToggleBtn').forEach(btn => {
            btn.setAttribute('title', label);
            btn.setAttribute('aria-label', label);
            btn.innerHTML = icon;
        });
    }

    toggleTheme() {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        this.applyTheme(current === 'dark' ? 'light' : 'dark');
    }

    bindEvents() {
        // Navigation
        document.getElementById('backBtn').addEventListener('click', () => this.showAppSelection());
        document.getElementById('formBackBtn').addEventListener('click', () => this.showSuggestions());
        document.getElementById('fabBtn').addEventListener('click', () => this.showSuggestionForm());
        document.getElementById('mobileNewBtn').addEventListener('click', () => this.showSuggestionForm());
        document.getElementById('cancelBtn').addEventListener('click', () => this.showSuggestions());

        // Form submission
        document.getElementById('newSuggestionForm').addEventListener('submit', (e) => this.submitSuggestion(e));
        document.getElementById('reportType').addEventListener('change', (e) => this.updateReportTypeUI(e.target.value));
        document.getElementById('entryNotificationsEnabled').addEventListener('change', (e) => {
            this.updateEntryNotificationUI(e.target.checked);
        });

        const themeBtn = document.getElementById('themeToggleBtn');
        if (themeBtn) {
            themeBtn.addEventListener('click', () => this.toggleTheme());
        }

        document.getElementById('bugScreenshotBtn').addEventListener('click', () => {
            document.getElementById('bugScreenshotInput').click();
        });
        document.getElementById('bugScreenshotInput').addEventListener('change', () => this.handleBugScreenshots());

        // View tabs
        document.getElementById('viewTabs').addEventListener('click', (e) => {
            const tab = e.target.closest('.view-tab');
            if (tab) this.switchView(tab.dataset.view);
        });

        window.addEventListener('popstate', () => this.applyUrlStateFromLocation());
    }

    // Navigation methods
    showSection(sectionId, showFab = false) {
        const sections = ['appSelection', 'suggestionsView', 'suggestionForm'];
        for (const id of sections) {
            document.getElementById(id).classList.toggle('hidden', id !== sectionId);
        }

        const appHeader = document.getElementById('appHeader');
        if (appHeader) {
            appHeader.classList.toggle('hidden', sectionId !== 'appSelection');
        }

        document.getElementById('fabBtn').style.display = showFab ? 'inline-flex' : 'none';
    }

    showAppSelection({ skipHistory = false, replaceHistory = false } = {}) {
        this.showSection('appSelection');
        this.currentApp = null;
        this.currentView = 'suggestions';
        this.allSuggestions = [];
        this.currentFilter = 'all';
        document.getElementById('currentAppName').textContent = 'App Name';
        document.getElementById('suggestionsFilters').innerHTML = '';
        document.getElementById('suggestionsList').innerHTML = '<div class="loading">Einträge werden geladen...</div>';

        if (!skipHistory) {
            this.navigateToUrlState({ appId: null, view: 'suggestions' }, { replace: replaceHistory });
        }
    }

    showSuggestions() {
        const showFab = this.currentView !== 'changelog';
        this.showSection('suggestionsView', showFab);
        document.getElementById('mobileNewBtn').style.display = this.currentView === 'suggestions' ? '' : 'none';
    }

    showSuggestionForm() {
        this.showSection('suggestionForm');
        document.getElementById('newSuggestionForm').reset();
        this.bugScreenshots = [];
        document.getElementById('bugScreenshotPreview').innerHTML = '';
        this.updateReportTypeUI('feature');
        this.updateEntryNotificationUI(false);
    }

    updateReportTypeUI(type) {
        this.currentReportType = ['bug', 'ticket'].includes(type) ? type : 'feature';
        const bugFields = document.getElementById('bugFields');
        const ticketFields = document.getElementById('ticketFields');
        const formTitle = document.getElementById('entryFormTitle');
        const submitBtn = document.getElementById('submitEntryBtn');
        const isBug = this.currentReportType === 'bug';
        const isTicket = this.currentReportType === 'ticket';

        bugFields.classList.toggle('hidden', !isBug);
        ticketFields.classList.toggle('hidden', !isTicket);

        document.getElementById('stepsToReproduce').required = isBug;
        document.getElementById('expectedBehavior').required = isBug;
        document.getElementById('actualBehavior').required = isBug;
        document.getElementById('bugSeverity').required = isBug;

        const descriptionEl = document.getElementById('suggestionDescription');
        if (isBug) {
            descriptionEl.placeholder = 'Kurze Zusammenfassung des Fehlers...';
        } else if (isTicket) {
            descriptionEl.placeholder = 'Beschreibe dein Anliegen...';
        } else {
            descriptionEl.placeholder = 'Detaillierte Beschreibung des Features...';
        }

        const titles = { bug: 'Bug melden', ticket: 'Support-Ticket erstellen', feature: 'Feature vorschlagen' };
        const buttons = { bug: 'Bug melden', ticket: 'Ticket erstellen', feature: 'Feature einreichen' };
        formTitle.textContent = titles[this.currentReportType];
        submitBtn.textContent = buttons[this.currentReportType];
    }

    updateEntryNotificationUI(enabled) {
        const emailGroup = document.getElementById('entryNotificationEmailGroup');
        const emailInput = document.getElementById('entryNotificationEmail');
        emailGroup.classList.toggle('hidden', !enabled);
        emailInput.required = enabled;
        if (!enabled) {
            emailInput.value = '';
        }
    }

    validateEmail(email) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(email);
    }

    getCurrentUrlState() {
        return {
            appId: this.currentApp?.id || null,
            view: this.currentView,
        };
    }

    findAppById(appId) {
        return this.apps.find(app => app.id === appId) || null;
    }

    navigateToUrlState(state, { replace = false } = {}) {
        const query = UrlState.buildUrlState(state);
        if (query === window.location.search) return;

        const nextUrl = `${window.location.pathname}${query}${window.location.hash || ''}`;
        if (replace) {
            history.replaceState(null, '', nextUrl);
            return;
        }

        history.pushState(null, '', nextUrl);
    }

    applyUrlStateFromLocation({ replace = false } = {}) {
        if (!this.apps.length) return;

        const state = UrlState.parseUrlState(window.location.search);
        this.applyUrlState(state, { replaceHistory: replace });
    }

    applyUrlState(state, { replaceHistory = false } = {}) {
        const normalizedState = {
            appId: state?.appId || null,
            view: UrlState.normalizeView(state?.view),
        };

        if (!normalizedState.appId) {
            this.showAppSelection({ skipHistory: true });
            if (replaceHistory) {
                this.navigateToUrlState(normalizedState, { replace: true });
            }
            return;
        }

        const app = this.findAppById(normalizedState.appId);
        if (!app) {
            this.showAppSelection({ skipHistory: true });
            this.navigateToUrlState({ appId: null, view: 'suggestions' }, { replace: true });
            this.showToast('App aus der URL wurde nicht gefunden', 'error');
            return;
        }

        this.selectApp(app.id, app.name, {
            view: normalizedState.view,
            skipHistory: true,
        });

        if (replaceHistory) {
            this.navigateToUrlState(normalizedState, { replace: true });
        }
    }

    syncCurrentView() {
        const suggestionsList = document.getElementById('suggestionsList');
        const suggestionsFilters = document.getElementById('suggestionsFilters');
        const roadmapView = document.getElementById('roadmapView');
        const changelogView = document.getElementById('changelogView');
        const fabBtn = document.getElementById('fabBtn');
        const mobileNewBtn = document.getElementById('mobileNewBtn');

        suggestionsList.classList.toggle('hidden', this.currentView !== 'suggestions');
        suggestionsFilters.classList.toggle('hidden', this.currentView !== 'suggestions');
        roadmapView.classList.toggle('hidden', this.currentView !== 'roadmap');
        changelogView.classList.toggle('hidden', this.currentView !== 'changelog');

        const showFab = this.currentView !== 'changelog';
        fabBtn.style.display = showFab ? 'inline-flex' : 'none';
        mobileNewBtn.style.display = (showFab && this.currentView === 'suggestions') ? '' : 'none';

        if (!this.currentApp) return;

        if (this.currentView === 'roadmap') {
            this.loadRoadmap(this.currentApp.id);
            return;
        }

        if (this.currentView === 'changelog') {
            this.loadChangelog(this.currentApp.id);
            return;
        }

        this.loadSuggestions(this.currentApp.id);
    }

    // API methods
    async loadApps() {
        try {
            const response = await fetch('/api/apps');

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const apps = await response.json();
            this.apps = apps;
            this.renderApps(apps);
            this.applyUrlStateFromLocation({ replace: true });
        } catch (error) {
            console.error('Error loading apps:', error);
            this.showToast('Fehler beim Laden der Apps', 'error');
        }
    }

    async loadSuggestions(appId) {
        try {
            const response = await fetch(`/api/apps/${appId}/suggestions`);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const suggestions = await response.json();

            if (!Array.isArray(suggestions)) {
                throw new Error('Invalid response format from server');
            }

            this.allSuggestions = suggestions;
            this.renderFilterBar();
            this.renderSuggestions(this.filterSuggestions(suggestions));
        } catch (error) {
            console.error('Error loading suggestions:', error);
            this.showToast('Fehler beim Laden der Einträge', 'error');
        }
    }

    async submitSuggestion(e) {
        e.preventDefault();

        const submitBtn = document.getElementById('submitEntryBtn');
        if (submitBtn.disabled) return;

        const type = document.getElementById('reportType').value;
        const title = document.getElementById('suggestionTitle').value.trim();
        const description = document.getElementById('suggestionDescription').value.trim();
        const notificationEnabled = document.getElementById('entryNotificationsEnabled').checked;
        const notificationEmail = document.getElementById('entryNotificationEmail').value.trim();

        if (!title || !description) {
            this.showToast('Bitte füllen Sie alle Felder aus', 'error');
            return;
        }

        if (notificationEnabled) {
            if (!notificationEmail) {
                this.showToast('Bitte E-Mail-Adresse für Benachrichtigungen eingeben', 'error');
                return;
            }
            if (!this.validateEmail(notificationEmail)) {
                this.showToast('Bitte geben Sie eine gültige E-Mail-Adresse ein', 'error');
                return;
            }
        }

        const payload = {
            type,
            title,
            description,
            notificationEnabled,
            notificationEmail: notificationEnabled ? notificationEmail : null,
        };

        if (type === 'bug') {
            const stepsToReproduce = document.getElementById('stepsToReproduce').value.trim();
            const expectedBehavior = document.getElementById('expectedBehavior').value.trim();
            const actualBehavior = document.getElementById('actualBehavior').value.trim();

            if (!stepsToReproduce || !expectedBehavior || !actualBehavior) {
                this.showToast('Bitte füllen Sie alle Bug-Felder aus', 'error');
                return;
            }

            payload.severity = document.getElementById('bugSeverity').value;
            payload.stepsToReproduce = stepsToReproduce;
            payload.expectedBehavior = expectedBehavior;
            payload.actualBehavior = actualBehavior;
            payload.environment = {
                platform: document.getElementById('environmentPlatform').value.trim(),
                browser: document.getElementById('environmentBrowser').value.trim(),
                appVersion: document.getElementById('environmentAppVersion').value.trim()
            };
        }

        if (type === 'bug' && this.bugScreenshots.length > 0) {
            payload.screenshots = this.bugScreenshots;
        }

        if (type === 'ticket') {
            payload.priority = document.getElementById('ticketPriority').value;
        }

        submitBtn.disabled = true;
        try {
            const response = await fetch(`/api/apps/${this.currentApp.id}/suggestions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                await response.json();
                this.showSuccessOverlay(type);
                this.loadSuggestions(this.currentApp.id);
            } else {
                const error = await response.json();
                this.showToast(error.error || 'Fehler beim Einreichen des Eintrags', 'error');
            }
        } catch (error) {
            console.error('Error submitting suggestion:', error);
            this.showToast('Fehler beim Einreichen des Eintrags', 'error');
        } finally {
            submitBtn.disabled = false;
        }
    }

    async voteSuggestion(suggestionId, button) {
        if (button.disabled) return;

        const isVoted = button.classList.contains('voted');
        button.disabled = true;

        try {
            const response = await fetch(`/api/suggestions/${suggestionId}/vote`, {
                method: isVoted ? 'DELETE' : 'POST',
                headers: { 'Content-Type': 'application/json' },
            });

            if (!response.ok) {
                const error = await response.json();
                this.showToast(error.error || 'Fehler beim Voten', 'error');
                return;
            }

            const voteCountEl = button.parentElement.querySelector('.vote-count');
            if (!voteCountEl) return;

            const currentCount = parseInt(voteCountEl.textContent);

            if (isVoted) {
                this.showToast('Vote erfolgreich entfernt!', 'success');
                button.classList.remove('voted');
                voteCountEl.classList.remove('voted');
                voteCountEl.textContent = Math.max(0, currentCount - 1);
                this.votedSuggestions.delete(suggestionId);
            } else {
                this.showToast('Vote erfolgreich abgegeben!', 'success');
                button.classList.add('voted');
                voteCountEl.classList.add('voted');
                voteCountEl.textContent = currentCount + 1;
                this.votedSuggestions.add(suggestionId);
            }

            this.saveVotedSuggestions();
        } catch (error) {
            console.error('Error voting:', error);
            this.showToast('Fehler beim Voten', 'error');
        } finally {
            button.disabled = false;
        }
    }

    // Filtering methods
    renderFilterBar() {
        const filterHost = document.getElementById('suggestionsFilters');
        if (!filterHost) return;

        if (this.allSuggestions.length === 0) {
            filterHost.innerHTML = '';
            return;
        }

        // Count suggestions by status
        const counts = {};
        counts['all'] = this.allSuggestions.length;

        this.allSuggestions.forEach(s => {
            const status = s.status || 'keine';
            counts[status] = (counts[status] || 0) + 1;
        });

        // Build filter list from actual statuses present
        const statusMeta = {
            'all':                  { label: 'Alle', color: '#6366F1' },
            // Feature statuses
            'neu':                  { label: 'Neu', color: '#ef4444' },
            'wird geprüft':        { label: 'Wird geprüft', color: '#f59e0b' },
            'wird umgesetzt':       { label: 'Wird umgesetzt', color: '#3b82f6' },
            'ist umgesetzt':        { label: 'Umgesetzt', color: '#059669' },
            'wird nicht umgesetzt': { label: 'Abgelehnt', color: '#ef4444' },
            // Ticket/Bug statuses
            'offen':                { label: 'Offen', color: '#3b82f6' },
            'in Bearbeitung':       { label: 'In Bearbeitung', color: '#f59e0b' },
            'wartend':              { label: 'Wartend', color: '#a855f7' },
            'gelöst':               { label: 'Gelöst', color: '#10b981' },
            'geschlossen':          { label: 'Geschlossen', color: '#64748b' },
            'keine':                { label: 'Ohne Status', color: '#64748b' },
        };

        const filters = Object.entries(statusMeta)
            .filter(([id]) => id === 'all' || (counts[id] && counts[id] > 0))
            .map(([id, meta]) => ({
                id,
                label: meta.label,
                count: counts[id] || 0,
                color: meta.color,
            }));

        // Only show filters with count > 0 (except 'all')
        const visibleFilters = filters.filter(f => f.id === 'all' || f.count > 0);

        const filterBar = `
            <div class="filter-bar">
                ${visibleFilters.map(filter => `
                    <button
                        onclick="app.setFilter('${filter.id}')"
                        class="filter-pill ${this.currentFilter === filter.id ? 'active' : ''}"
                        style="--filter-color: ${filter.color};"
                    >
                        <span class="filter-dot" aria-hidden="true"></span>
                        <span>${filter.label}</span>
                        <span class="filter-count">${filter.count}</span>
                    </button>
                `).join('')}
            </div>
        `;

        filterHost.innerHTML = filterBar;
    }

    setFilter(filterId) {
        this.currentFilter = filterId;
        this.renderFilterBar();
        this.renderSuggestions(this.filterSuggestions(this.allSuggestions));
    }

    filterSuggestions(suggestions) {
        if (this.currentFilter === 'all') return suggestions;
        if (this.currentFilter === 'keine') return suggestions.filter(s => !s.status);
        return suggestions.filter(s => s.status === this.currentFilter);
    }

    // Rendering methods
    renderApps(apps) {
        const appGrid = document.getElementById('appGrid');

        if (apps.length === 0) {
            appGrid.innerHTML = '<div class="loading">Keine Apps verfügbar</div>';
            return;
        }

        appGrid.innerHTML = apps.map(app => `
            <div class="app-card" onclick="app.selectApp('${app.id}', '${app.name}')">
                <h3>${this.escapeHtml(app.name)}</h3>
                <p>${this.escapeHtml(app.description || 'Keine Beschreibung verfügbar')}</p>
            </div>
        `).join('');
    }

    renderSuggestions(suggestions) {
        const suggestionsList = document.getElementById('suggestionsList');

        suggestionsList.querySelectorAll('.suggestion-card').forEach(card => card.remove());

        const loadingMsg = suggestionsList.querySelector('.loading:not(.filter-bar-container .loading)');
        if (loadingMsg && !loadingMsg.closest('.filter-bar-container')) {
            loadingMsg.remove();
        }

        if (suggestions.length === 0) {
            const noResultsMsg = document.createElement('div');
            noResultsMsg.className = 'loading';
            noResultsMsg.innerHTML = `
                ${this.currentFilter === 'all' ?
                    'Noch keine Einträge vorhanden.<br>Seien Sie der Erste und reichen Sie einen Eintrag ein!' :
                    'Keine Einträge mit diesem Status gefunden.'
                }
            `;
            suggestionsList.appendChild(noResultsMsg);
            return;
        }

        const suggestionsHTML = suggestions.map(suggestion => {
            const suggestionType = suggestion.type || 'feature';
            const status = suggestion.status || '';

            // Check if resolved (faded out)
            const resolvedStatuses = VotingApp.RESOLVED_STATUSES;
            const isImplemented = resolvedStatuses.includes(status);
            const cardOpacity = isImplemented ? 'opacity: 0.5;' : '';
            const isBug = suggestionType === 'bug';
            const isTicket = suggestionType === 'ticket';
            const isFeature = suggestionType === 'feature';

            // Ticket number badge
            const ticketNumberBadge = suggestion.ticketNumber
                ? `<span class="ticket-number">${this.escapeHtml(suggestion.ticketNumber)}</span>`
                : '';

            // Status badge (uses status field)
            let statusBadge = '';
            if (status && status !== 'neu') {
                const { color: statusColor, icon: statusIcon } =
                    VotingApp.TAG_STYLES[status] || VotingApp.DEFAULT_TAG_STYLE;

                statusBadge = `
                    <div class="badge-row">
                        <span class="label" style="--label-color: ${statusColor};">
                            <span class="label-dot" aria-hidden="true"></span>
                            <span>${statusIcon}</span>
                            <span>${this.escapeHtml(status)}</span>
                        </span>
                    </div>
                `;
            }

            // Priority badge (for all types)
            let priorityBadge = '';
            if (suggestion.priority && suggestion.priority !== 'mittel') {
                const pStyle = VotingApp.PRIORITY_STYLES[suggestion.priority];
                if (pStyle) {
                    priorityBadge = `
                        <span class="priority-badge" style="--priority-color: ${pStyle.color};">
                            ${this.escapeHtml(pStyle.label)}
                        </span>
                    `;
                }
            }

            // Type badge
            let typeBadge = '';
            if (isBug) {
                typeBadge = `<div class="badge-row">
                        <span class="label" style="--label-color: #ef4444;">
                            <span class="label-dot" aria-hidden="true"></span>
                            <span>\uD83D\uDC1E Bug</span>
                            <span>${this.escapeHtml((suggestion.severity || 'medium').toUpperCase())}</span>
                        </span>
                    </div>`;
            } else if (isTicket) {
                typeBadge = `<div class="badge-row">
                        <span class="label" style="--label-color: #a855f7;">
                            <span class="label-dot" aria-hidden="true"></span>
                            <span>\uD83C\uDFAB Ticket</span>
                        </span>
                    </div>`;
            }

            // Bug screenshots
            const screenshotGallery = (suggestion.screenshots && suggestion.screenshots.length > 0)
                ? `<div class="bug-screenshots">
                    ${suggestion.screenshots.map((src, idx) =>
                        `<img src="${src}" alt="Screenshot ${idx + 1}" onclick="app.showImageModal(this.src)">`
                    ).join('')}
                  </div>`
                : '';

            // Labels
            const labelBadges = (suggestion.labels || []).length > 0
                ? `<div class="badge-row">${suggestion.labels.map(l =>
                    `<span class="label-pill">${this.escapeHtml(l)}</span>`
                  ).join('')}</div>`
                : '';

            const commentBadge = suggestion.commentCount > 0
                ? `<div class="badge-row">
                        <button
                            onclick="app.toggleComments('${suggestion.id}'); event.stopPropagation();"
                            class="label label-button"
                            style="--label-color: #3b82f6;"
                        >
                            <span class="label-dot" aria-hidden="true"></span>
                            <span>Kommentare</span>
                            <span>(${suggestion.commentCount})</span>
                        </button>
                    </div>`
                : '';

            // Icon column: vote for features, icons for bugs/tickets
            let iconColumn;
            if (isFeature) {
                iconColumn = `<div class="vote-column">
                    <button
                        class="upvote-btn ${suggestion.hasVoted ? 'voted' : ''}"
                        ${suggestion.hasVoted || isImplemented ? 'disabled' : ''}
                        onclick="app.voteSuggestion('${suggestion.id}', this)"
                        title="${suggestion.hasVoted ? 'Vote entfernen' : 'Upvoten'}"
                    >▲</button>
                    <span class="vote-count ${suggestion.hasVoted ? 'voted' : ''}">${suggestion.votes || 0}</span>
                </div>`;
            } else if (isBug) {
                iconColumn = `<div class="bug-icon-column">\uD83D\uDC1E</div>`;
            } else {
                iconColumn = `<div class="ticket-icon-column">\uD83C\uDFAB</div>`;
            }

            return `
                <div class="suggestion-card" style="${cardOpacity}">
                    <div class="suggestion-layout">
                        ${iconColumn}
                        <div class="suggestion-content">
                            <div class="suggestion-title-row">
                                ${ticketNumberBadge}
                                <h3 class="suggestion-title">${this.escapeHtml(suggestion.title)}</h3>
                                ${priorityBadge}
                            </div>
                            <p class="suggestion-description">${this.escapeHtml(suggestion.description)}</p>
                            ${screenshotGallery}
                            ${typeBadge}
                            ${statusBadge}
                            ${labelBadges}
                            ${commentBadge}
                            <div id="comments-${suggestion.id}" class="comments-section">
                                <div class="loading">Kommentare werden geladen...</div>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        const tempContainer = document.createElement('div');
        tempContainer.innerHTML = suggestionsHTML;
        Array.from(tempContainer.children).forEach(child => {
            suggestionsList.appendChild(child);
        });
    }

    selectApp(appId, appName, { view = 'suggestions', skipHistory = false, replaceHistory = false } = {}) {
        const appChanged = this.currentApp?.id !== appId;
        this.currentApp = { id: appId, name: appName };
        document.getElementById('currentAppName').textContent = appName;
        this.currentView = UrlState.normalizeView(view);

        if (appChanged) {
            this.currentFilter = 'all';
        }

        this.updateViewTabs();
        this.showSuggestions();

        if (!skipHistory) {
            this.navigateToUrlState(this.getCurrentUrlState(), { replace: replaceHistory });
        }

        this.syncCurrentView();
    }

    switchView(view, { skipHistory = false, replaceHistory = false } = {}) {
        this.currentView = UrlState.normalizeView(view);
        this.updateViewTabs();

        if (!skipHistory && this.currentApp) {
            this.navigateToUrlState(this.getCurrentUrlState(), { replace: replaceHistory });
        }

        this.syncCurrentView();
    }

    updateViewTabs() {
        document.querySelectorAll('#viewTabs .view-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.view === this.currentView);
        });
    }

    async loadRoadmap(appId) {
        const roadmapView = document.getElementById('roadmapView');
        roadmapView.innerHTML = '<div class="loading">Roadmap wird geladen...</div>';

        try {
            const response = await fetch(`/api/apps/${appId}/releases?status=geplant,in Arbeit`);
            const releases = await response.json();

            if (!response.ok) throw new Error(releases.error);
            this.renderRoadmap(releases);
        } catch (error) {
            console.error('Error loading roadmap:', error);
            roadmapView.innerHTML = '<div class="loading">Fehler beim Laden der Roadmap.</div>';
        }
    }

    async loadChangelog(appId) {
        const changelogView = document.getElementById('changelogView');
        changelogView.innerHTML = '<div class="loading">Changelog wird geladen...</div>';

        try {
            const response = await fetch(`/api/apps/${appId}/releases?status=veröffentlicht`);
            const releases = await response.json();

            if (!response.ok) throw new Error(releases.error);
            this.renderChangelog(releases);
        } catch (error) {
            console.error('Error loading changelog:', error);
            changelogView.innerHTML = '<div class="loading">Fehler beim Laden des Changelogs.</div>';
        }
    }

    renderRoadmap(releases) {
        const roadmapView = document.getElementById('roadmapView');

        if (releases.length === 0) {
            roadmapView.innerHTML = '<div class="release-empty">Noch keine Releases geplant.</div>';
            return;
        }

        roadmapView.innerHTML = releases.map(release => {
            const statusLabel = release.status === 'in Arbeit' ? 'In Arbeit' : 'Geplant';
            const statusColor = release.status === 'in Arbeit' ? '#f59e0b' : '#3b82f6';
            const dateStr = this.formatDateShort(release.releaseDate);

            const items = (release.items || []).map(item => {
                const typeIcon = item.type === 'bug' ? '\uD83D\uDC1E' : item.type === 'ticket' ? '\uD83C\uDFAB' : '\u2728';
                const statusStyle = VotingApp.TAG_STYLES[item.status] || VotingApp.DEFAULT_TAG_STYLE;
                return `
                    <div class="release-item">
                        <span class="release-item-icon">${typeIcon}</span>
                        ${item.ticketNumber ? `<span class="ticket-number">${this.escapeHtml(item.ticketNumber)}</span>` : ''}
                        <span class="release-item-title">${this.escapeHtml(item.title)}</span>
                        <span class="label" style="--label-color: ${statusStyle.color}; font-size: 0.75rem;">
                            <span class="label-dot" aria-hidden="true"></span>
                            <span>${this.escapeHtml(item.status)}</span>
                        </span>
                    </div>
                `;
            }).join('');

            return `
                <div class="release-card">
                    <div class="release-header">
                        <div class="release-header-left">
                            <span class="release-status-badge" style="background: ${statusColor};">${statusLabel}</span>
                            <span class="release-version">v${this.escapeHtml(release.version)}</span>
                            ${release.title ? `<span class="release-title-text">— ${this.escapeHtml(release.title)}</span>` : ''}
                        </div>
                        ${dateStr ? `<span class="release-date">voraussichtlich ${dateStr}</span>` : ''}
                    </div>
                    ${release.description ? `<p class="release-description">${this.escapeHtml(release.description)}</p>` : ''}
                    ${items ? `<div class="release-items">${items}</div>` : '<p class="release-no-items">Noch keine Einträge zugeordnet.</p>'}
                </div>
            `;
        }).join('');
    }

    renderChangelog(releases) {
        const changelogView = document.getElementById('changelogView');

        if (releases.length === 0) {
            changelogView.innerHTML = '<div class="release-empty">Noch kein Changelog vorhanden.</div>';
            return;
        }

        changelogView.innerHTML = releases.map(release => {
            const dateStr = this.formatDateShort(release.releaseDate || release.publishedAt);

            // Group items by type
            const features = (release.items || []).filter(i => i.type === 'feature');
            const bugs = (release.items || []).filter(i => i.type === 'bug');
            const tickets = (release.items || []).filter(i => i.type === 'ticket');

            const renderGroup = (title, icon, items) => {
                if (items.length === 0) return '';
                return `
                    <div class="release-type-group">
                        <h4 class="release-group-title">${icon} ${title}</h4>
                        ${items.map(item => `
                            <div class="release-item">
                                ${item.ticketNumber ? `<span class="ticket-number">${this.escapeHtml(item.ticketNumber)}</span>` : ''}
                                <span class="release-item-title">${this.escapeHtml(item.title)}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
            };

            const hasItems = features.length + bugs.length + tickets.length > 0;

            return `
                <div class="release-card">
                    <div class="release-header">
                        <div class="release-header-left">
                            <span class="release-version">v${this.escapeHtml(release.version)}</span>
                            ${release.title ? `<span class="release-title-text">— ${this.escapeHtml(release.title)}</span>` : ''}
                        </div>
                        ${dateStr ? `<span class="release-date">${dateStr}</span>` : ''}
                    </div>
                    ${release.description ? `<p class="release-description">${this.escapeHtml(release.description)}</p>` : ''}
                    ${hasItems ? `
                        <div class="release-items-grouped">
                            ${renderGroup('Neue Features', '\u2728', features)}
                            ${renderGroup('Fehlerbehebungen', '\uD83D\uDC1E', bugs)}
                            ${renderGroup('Tickets', '\uD83C\uDFAB', tickets)}
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    }

    formatDateShort(timestamp) {
        if (!timestamp) return '';
        try {
            let date;
            if (timestamp._seconds !== undefined) date = new Date(timestamp._seconds * 1000);
            else if (timestamp.seconds !== undefined) date = new Date(timestamp.seconds * 1000);
            else if (typeof timestamp === 'string' || typeof timestamp === 'number') date = new Date(timestamp);
            else return '';
            if (isNaN(date.getTime())) return '';
            return date.toLocaleDateString('de-DE', { year: 'numeric', month: 'long', day: 'numeric' });
        } catch {
            return '';
        }
    }

    // Utility methods
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type}`;

        // Show toast
        toast.classList.add('show');

        // Hide after 3 seconds
        setTimeout(() => {
            toast.classList.remove('show');
        }, 3000);
    }

    getVotedSuggestions() {
        try {
            return JSON.parse(localStorage.getItem('votedSuggestions') || '[]');
        } catch {
            return [];
        }
    }

    saveVotedSuggestions() {
        try {
            localStorage.setItem('votedSuggestions', JSON.stringify([...this.votedSuggestions]));
        } catch (error) {
            console.error('Error saving voted suggestions:', error);
        }
    }

    formatDate(timestamp) {
        if (!timestamp) return 'Unbekannt';
        try {
            let date;

            // Handle Firestore timestamp object
            if (timestamp._seconds !== undefined) {
                date = new Date(timestamp._seconds * 1000);
            } else if (timestamp.seconds !== undefined) {
                date = new Date(timestamp.seconds * 1000);
            } else if (typeof timestamp === 'string' || typeof timestamp === 'number') {
                date = new Date(timestamp);
            } else {
                return 'Unbekannt';
            }

            // Check if date is valid
            if (isNaN(date.getTime())) {
                return 'Unbekannt';
            }

            return date.toLocaleDateString('de-DE', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (error) {
            console.error('Error formatting date:', error);
            return 'Unbekannt';
        }
    }

    showSuccessOverlay(type = 'feature') {
        const titles = {
            bug: 'Bug gemeldet!',
            ticket: 'Ticket erstellt!',
            feature: 'Vorschlag eingereicht!',
        };
        const messages = {
            bug: 'Dein Bug-Report wurde erfolgreich eingereicht und wartet nun auf Freigabe durch einen Administrator.',
            ticket: 'Dein Ticket wurde erfolgreich erstellt und wartet nun auf Freigabe durch einen Administrator.',
            feature: 'Dein Vorschlag wurde erfolgreich eingereicht und wartet nun auf Freigabe durch einen Administrator.',
        };

        document.getElementById('successOverlayTitle').textContent = titles[type] || titles.feature;
        document.getElementById('successOverlayMessage').textContent = messages[type] || messages.feature;

        document.getElementById('successOverlay').classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    closeSuccessOverlay() {
        document.getElementById('successOverlay').classList.add('hidden');
        document.body.style.overflow = '';
        this.showSuggestions();
    }

    async toggleComments(suggestionId) {
        const commentsDiv = document.getElementById(`comments-${suggestionId}`);
        const isHidden = commentsDiv.style.display === 'none' || !commentsDiv.style.display;

        commentsDiv.style.display = isHidden ? 'block' : 'none';
        if (isHidden) {
            await this.loadComments(suggestionId);
        }
    }

    async loadComments(suggestionId) {
        const commentsDiv = document.getElementById(`comments-${suggestionId}`);

        try {
            const response = await fetch(`/api/suggestions/${suggestionId}/comments`);
            const comments = await response.json();

            if (response.ok) {
                this.renderComments(suggestionId, comments);
            } else {
                throw new Error(comments.error);
            }
        } catch (error) {
            console.error('Error loading comments:', error);
            commentsDiv.innerHTML = '<div class="comments-error">Fehler beim Laden der Kommentare</div>';
        }
    }

    renderComments(suggestionId, comments) {
        const commentsDiv = document.getElementById(`comments-${suggestionId}`);

        if (comments.length === 0) {
            commentsDiv.innerHTML = '<p class="comments-empty">Noch keine Kommentare vorhanden.</p>';
            return;
        }

        const commentsHTML = comments.map((comment, commentIdx) => `
            <div class="comment-card">
                <div class="comment-header">
                    <span class="comment-admin-badge">ADMIN</span>
                    <span class="comment-date">${this.formatDate(comment.createdAt)}</span>
                </div>
                <p class="comment-text">${this.escapeHtml(comment.text)}</p>
                ${comment.screenshots && comment.screenshots.length > 0 ? `
                    <div class="comment-screenshots">
                        ${comment.screenshots.map((screenshot, idx) => `
                            <img
                                src="${screenshot}"
                                alt="Screenshot ${idx + 1}"
                                class="comment-screenshot"
                                data-screenshot-index="${commentIdx}-${idx}"
                                onclick="app.showImageModal(this.src)"
                            >
                        `).join('')}
                    </div>
                ` : ''}
            </div>
        `).join('');

        commentsDiv.innerHTML = `<div class="comments-list">${commentsHTML}</div>`;
    }

    handleBugScreenshots() {
        const fileInput = document.getElementById('bugScreenshotInput');
        const files = Array.from(fileInput.files);

        if (this.bugScreenshots.length + files.length > 3) {
            this.showToast('Maximal 3 Screenshots erlaubt', 'error');
            fileInput.value = '';
            return;
        }

        files.forEach(file => {
            this.compressImage(file, 600, 0.5).then(dataUrl => {
                if (dataUrl.length > 200000) {
                    this.showToast('Bild zu groß, wird übersprungen', 'error');
                    return;
                }
                this.bugScreenshots.push(dataUrl);
                this.renderBugScreenshotPreview();
            }).catch(() => {
                this.showToast('Fehler beim Verarbeiten des Bildes', 'error');
            });
        });

        fileInput.value = '';
    }

    compressImage(file, maxWidth, quality) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    let width = img.width;
                    let height = img.height;
                    if (width > maxWidth) {
                        height = (height * maxWidth) / width;
                        width = maxWidth;
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    removeBugScreenshot(index) {
        this.bugScreenshots.splice(index, 1);
        this.renderBugScreenshotPreview();
    }

    renderBugScreenshotPreview() {
        const preview = document.getElementById('bugScreenshotPreview');
        preview.innerHTML = this.bugScreenshots.map((src, idx) => `
            <div class="screenshot-thumb">
                <img src="${src}" alt="Screenshot ${idx + 1}">
                <button type="button" class="remove-btn" onclick="app.removeBugScreenshot(${idx})">×</button>
            </div>
        `).join('');
    }

    showImageModal(imageSrc) {
        document.getElementById('modalImage').src = imageSrc;
        document.getElementById('imageModal').classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    closeImageModal() {
        document.getElementById('imageModal').classList.add('hidden');
        document.body.style.overflow = '';
    }
}

// Initialize the app
const app = new VotingApp();
