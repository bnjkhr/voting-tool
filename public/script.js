class VotingApp {
    static TAG_STYLES = {
        'wird umgesetzt':       { color: '#3b82f6', icon: '\u2713' },
        'ist umgesetzt':        { color: '#059669', icon: '\u2713\u2713' },
        'umgesetzt':            { color: '#059669', icon: '\u2713\u2713' },
        'wird nicht umgesetzt': { color: '#ef4444', icon: '\u2717' },
        'wird gepr\u00fcft':    { color: '#f59e0b', icon: '\u231B' },
        'neu':                  { color: '#ef4444', icon: '\uD83D\uDC1E' },
        'in analyse':           { color: '#f59e0b', icon: '\uD83D\uDD0E' },
        'behoben':              { color: '#10b981', icon: '\u2713' },
        'nicht reproduzierbar': { color: '#64748b', icon: '\u2205' },
    };

    static DEFAULT_TAG_STYLE = { color: '#64748b', icon: '\u2022' };

    constructor() {
        this.currentApp = null;
        this.votedSuggestions = new Set(this.getVotedSuggestions());
        this.currentFilter = 'all';
        this.allSuggestions = [];
        this.currentReportType = 'feature';
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

        const btn = document.getElementById('themeToggleBtn');
        if (!btn) return;

        const isDark = theme === 'dark';
        btn.setAttribute('title', isDark ? 'Light Mode aktivieren' : 'Dark Mode aktivieren');
        btn.setAttribute('aria-label', isDark ? 'Light Mode aktivieren' : 'Dark Mode aktivieren');
        btn.innerHTML = isDark
            ? `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <circle cx="12" cy="12" r="5"/>
                 <line x1="12" y1="1" x2="12" y2="3"/>
                 <line x1="12" y1="21" x2="12" y2="23"/>
                 <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                 <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                 <line x1="1" y1="12" x2="3" y2="12"/>
                 <line x1="21" y1="12" x2="23" y2="12"/>
                 <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                 <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
               </svg>`
            : `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                 <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
               </svg>`;
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
    }

    // Navigation methods
    showSection(sectionId, showFab = false) {
        const sections = ['appSelection', 'suggestionsView', 'suggestionForm'];
        for (const id of sections) {
            document.getElementById(id).classList.toggle('hidden', id !== sectionId);
        }
        document.getElementById('fabBtn').style.display = showFab ? 'flex' : 'none';
    }

    showAppSelection() {
        this.showSection('appSelection');
        this.currentApp = null;
    }

    showSuggestions() {
        this.showSection('suggestionsView', true);
    }

    showSuggestionForm() {
        this.showSection('suggestionForm');
        document.getElementById('newSuggestionForm').reset();
        this.updateReportTypeUI('feature');
        this.updateEntryNotificationUI(false);
    }

    updateReportTypeUI(type) {
        this.currentReportType = type === 'bug' ? 'bug' : 'feature';
        const bugFields = document.getElementById('bugFields');
        const formTitle = document.getElementById('entryFormTitle');
        const submitBtn = document.getElementById('submitEntryBtn');
        const isBug = this.currentReportType === 'bug';

        bugFields.classList.toggle('hidden', !isBug);

        document.getElementById('stepsToReproduce').required = isBug;
        document.getElementById('expectedBehavior').required = isBug;
        document.getElementById('actualBehavior').required = isBug;
        document.getElementById('bugSeverity').required = isBug;

        const descriptionEl = document.getElementById('suggestionDescription');
        descriptionEl.placeholder = isBug
            ? 'Kurze Zusammenfassung des Fehlers...'
            : 'Detaillierte Beschreibung des Features...';

        formTitle.textContent = isBug ? 'Bug melden' : 'Feature vorschlagen';
        submitBtn.textContent = isBug ? 'Bug melden' : 'Feature einreichen';
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

    // API methods
    async loadApps() {
        try {
            const response = await fetch('/api/apps');

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`HTTP ${response.status}: ${errorText}`);
            }

            const apps = await response.json();
            this.renderApps(apps);
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
        const suggestionsList = document.getElementById('suggestionsList');

        // Don't render filter bar if no suggestions at all
        if (this.allSuggestions.length === 0) {
            return;
        }

        // Count suggestions by tag
        const counts = {
            all: this.allSuggestions.length,
            'wird umgesetzt': 0,
            'ist umgesetzt': 0,
            'wird geprüft': 0,
            'wird nicht umgesetzt': 0,
            'neu': 0,
            'in analyse': 0,
            'behoben': 0,
            'nicht reproduzierbar': 0,
            'keine': 0
        };

        this.allSuggestions.forEach(s => {
            if (s.tag && counts.hasOwnProperty(s.tag)) {
                counts[s.tag]++;
            } else {
                counts['keine']++;
            }
        });

        const filters = [
            { id: 'all', label: 'Alle', count: counts.all, color: '#6366F1' },
            { id: 'wird umgesetzt', label: 'Wird umgesetzt', count: counts['wird umgesetzt'], color: '#3b82f6' },
            { id: 'ist umgesetzt', label: 'Ist umgesetzt', count: counts['ist umgesetzt'], color: '#059669' },
            { id: 'wird geprüft', label: 'Wird geprüft', count: counts['wird geprüft'], color: '#f59e0b' },
            { id: 'wird nicht umgesetzt', label: 'Wird nicht umgesetzt', count: counts['wird nicht umgesetzt'], color: '#ef4444' },
            { id: 'neu', label: 'Bug: Neu', count: counts['neu'], color: '#ef4444' },
            { id: 'in analyse', label: 'Bug: In Analyse', count: counts['in analyse'], color: '#f59e0b' },
            { id: 'behoben', label: 'Bug: Behoben', count: counts['behoben'], color: '#10b981' },
            { id: 'nicht reproduzierbar', label: 'Bug: Nicht reproduzierbar', count: counts['nicht reproduzierbar'], color: '#64748b' },
            { id: 'keine', label: 'Ohne Status', count: counts['keine'], color: '#64748b' }
        ];

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

        // Prepend filter bar to suggestions list
        const existingFilterBar = suggestionsList.querySelector('.filter-bar-container');
        if (existingFilterBar) {
            existingFilterBar.remove();
        }

        const filterContainer = document.createElement('div');
        filterContainer.className = 'filter-bar-container';
        filterContainer.innerHTML = filterBar;
        suggestionsList.insertBefore(filterContainer, suggestionsList.firstChild);
    }

    setFilter(filterId) {
        this.currentFilter = filterId;
        this.renderFilterBar();
        this.renderSuggestions(this.filterSuggestions(this.allSuggestions));
    }

    filterSuggestions(suggestions) {
        if (this.currentFilter === 'all') return suggestions;
        if (this.currentFilter === 'keine') return suggestions.filter(s => !s.tag);
        return suggestions.filter(s => s.tag === this.currentFilter);
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
            // Check if suggestion is implemented (ausgegraut)
            const normalizedTag = (suggestion.tag || '').trim().toLowerCase();
            const isImplemented = suggestionType === 'feature'
                ? (normalizedTag === 'ist umgesetzt' || normalizedTag === 'umgesetzt')
                : normalizedTag === 'behoben';
            const cardOpacity = isImplemented ? 'opacity: 0.5;' : '';
            const isBug = suggestionType === 'bug';

            let tagBadge = '';
            if (suggestion.tag) {
                const { color: tagColor, icon: tagIcon } =
                    VotingApp.TAG_STYLES[suggestion.tag] || VotingApp.DEFAULT_TAG_STYLE;

                tagBadge = `
                    <div class="badge-row">
                        <span class="label" style="--label-color: ${tagColor};">
                            <span class="label-dot" aria-hidden="true"></span>
                            <span>${tagIcon}</span>
                            <span>${this.escapeHtml(suggestion.tag)}</span>
                        </span>
                    </div>
                `;
            }

            const typeBadge = isBug
                ? `<div class="badge-row">
                        <span class="label" style="--label-color: #ef4444;">
                            <span class="label-dot" aria-hidden="true"></span>
                            <span>\uD83D\uDC1E Bug</span>
                            <span>${this.escapeHtml((suggestion.severity || 'medium').toUpperCase())}</span>
                        </span>
                    </div>`
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

            return `
                <div class="suggestion-card" style="${cardOpacity}">
                    <div class="suggestion-layout">
                        ${isBug
                            ? `<div class="bug-icon-column">🐞</div>`
                            : `<div class="vote-column">
                                   <button
                                       class="upvote-btn ${suggestion.hasVoted ? 'voted' : ''}"
                                       ${suggestion.hasVoted || isImplemented ? 'disabled' : ''}
                                       onclick="app.voteSuggestion('${suggestion.id}', this)"
                                       title="${suggestion.hasVoted ? 'Vote entfernen' : 'Upvoten'}"
                                   >▲</button>
                                   <span class="vote-count ${suggestion.hasVoted ? 'voted' : ''}">${suggestion.votes || 0}</span>
                               </div>`
                        }
                        <div class="suggestion-content">
                            <h3 class="suggestion-title">${this.escapeHtml(suggestion.title)}</h3>
                            <p class="suggestion-description">${this.escapeHtml(suggestion.description)}</p>
                            ${typeBadge}
                            ${tagBadge}
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

    selectApp(appId, appName) {
        this.currentApp = { id: appId, name: appName };
        document.getElementById('currentAppName').textContent = appName;
        this.showSuggestions();
        this.loadSuggestions(appId);
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
        const isBug = type === 'bug';
        document.getElementById('successOverlayTitle').textContent =
            isBug ? 'Bug gemeldet!' : 'Vorschlag eingereicht!';
        document.getElementById('successOverlayMessage').textContent =
            isBug
                ? 'Dein Bug-Report wurde erfolgreich eingereicht und wartet nun auf Freigabe durch einen Administrator.'
                : 'Dein Vorschlag wurde erfolgreich eingereicht und wartet nun auf Freigabe durch einen Administrator.';

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
