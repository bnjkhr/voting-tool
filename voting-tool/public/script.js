class VotingApp {
    constructor() {
        this.currentApp = null;
        this.votedSuggestions = new Set(this.getVotedSuggestions());
        this.init();
    }

    init() {
        this.bindEvents();
        this.loadApps();
    }

    bindEvents() {
        // Navigation
        document.getElementById('backBtn').addEventListener('click', () => this.showAppSelection());
        document.getElementById('formBackBtn').addEventListener('click', () => this.showSuggestions());
        document.getElementById('fabBtn').addEventListener('click', () => this.showSuggestionForm());
        document.getElementById('cancelBtn').addEventListener('click', () => this.showSuggestions());

        // Form submission
        document.getElementById('newSuggestionForm').addEventListener('submit', (e) => this.submitSuggestion(e));
    }

    // Navigation methods
    showAppSelection() {
        document.getElementById('appSelection').classList.remove('hidden');
        document.getElementById('suggestionsView').classList.add('hidden');
        document.getElementById('suggestionForm').classList.add('hidden');
        document.getElementById('fabBtn').style.display = 'none';
        this.currentApp = null;
    }

    showSuggestions() {
        document.getElementById('appSelection').classList.add('hidden');
        document.getElementById('suggestionsView').classList.remove('hidden');
        document.getElementById('suggestionForm').classList.add('hidden');
        document.getElementById('fabBtn').style.display = 'flex';
    }

    showSuggestionForm() {
        document.getElementById('appSelection').classList.add('hidden');
        document.getElementById('suggestionsView').classList.add('hidden');
        document.getElementById('suggestionForm').classList.remove('hidden');
        document.getElementById('fabBtn').style.display = 'none';

        // Clear form
        document.getElementById('newSuggestionForm').reset();
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

            if (apps.length === 0) {
                this.renderApps([]);
                return;
            }

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

            // Ensure suggestions is an array
            if (!Array.isArray(suggestions)) {
                throw new Error('Invalid response format from server');
            }

            // Check vote status for each suggestion
            for (const suggestion of suggestions) {
                try {
                    const voteResponse = await fetch(`/api/suggestions/${suggestion.id}/voted`);
                    if (voteResponse.ok) {
                        const { voted } = await voteResponse.json();
                        suggestion.hasVoted = voted;
                    } else {
                        suggestion.hasVoted = false;
                    }
                } catch (error) {
                    console.error('Error checking vote status:', error);
                    suggestion.hasVoted = false;
                }
            }

            this.renderSuggestions(suggestions);
        } catch (error) {
            console.error('Error loading suggestions:', error);
            this.showToast('Fehler beim Laden der Vorschläge', 'error');
        }
    }

    async submitSuggestion(e) {
        e.preventDefault();

        const title = document.getElementById('suggestionTitle').value.trim();
        const description = document.getElementById('suggestionDescription').value.trim();

        if (!title || !description) {
            this.showToast('Bitte füllen Sie alle Felder aus', 'error');
            return;
        }

        try {
            const response = await fetch(`/api/apps/${this.currentApp.id}/suggestions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ title, description })
            });

            if (response.ok) {
                const result = await response.json();
                this.showSuccessOverlay();
                this.loadSuggestions(this.currentApp.id);
            } else {
                const error = await response.json();
                this.showToast(error.error || 'Fehler beim Einreichen des Vorschlags', 'error');
            }
        } catch (error) {
            console.error('Error submitting suggestion:', error);
            this.showToast('Fehler beim Einreichen des Vorschlags', 'error');
        }
    }

    async voteSuggestion(suggestionId, button) {
        if (button.disabled) return;

        const isVoted = button.classList.contains('voted');

        try {
            button.disabled = true;
            button.textContent = isVoted ? 'Removing...' : 'Voting...';

            const url = `/api/suggestions/${suggestionId}/vote`;
            const method = isVoted ? 'DELETE' : 'POST';

            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            if (response.ok) {
                const voteCountEl = button.parentElement.querySelector('.vote-count');
                const currentCount = parseInt(voteCountEl.textContent);

                if (isVoted) {
                    // Unvote
                    this.showToast('Vote erfolgreich entfernt!', 'success');
                    button.textContent = 'Vote';
                    button.classList.remove('voted');
                    voteCountEl.textContent = Math.max(0, currentCount - 1);
                    this.votedSuggestions.delete(suggestionId);
                } else {
                    // Vote
                    this.showToast('Vote erfolgreich abgegeben!', 'success');
                    button.textContent = 'Gevotet';
                    button.classList.add('voted');
                    voteCountEl.textContent = currentCount + 1;
                    this.votedSuggestions.add(suggestionId);
                }

                this.saveVotedSuggestions();
                button.disabled = false;
            } else {
                const error = await response.json();
                this.showToast(error.error || 'Fehler beim Voten', 'error');
                button.disabled = false;
                button.textContent = isVoted ? 'Gevotet' : 'Vote';
            }
        } catch (error) {
            console.error('Error voting:', error);
            this.showToast('Fehler beim Voten', 'error');
            button.disabled = false;
            button.textContent = isVoted ? 'Gevotet' : 'Vote';
        }
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

        if (suggestions.length === 0) {
            suggestionsList.innerHTML = `
                <div class="loading">
                    Noch keine Vorschläge vorhanden.<br>
                    Seien Sie der Erste und reichen Sie einen Vorschlag ein!
                </div>
            `;
            return;
        }

        suggestionsList.innerHTML = suggestions.map(suggestion => {
            // Generate tag badge if tag exists
            let tagBadge = '';
            if (suggestion.tag) {
                let tagColor = '';
                let tagIcon = '';

                switch (suggestion.tag) {
                    case 'wird umgesetzt':
                        tagColor = '#10b981'; // green
                        tagIcon = '✓';
                        break;
                    case 'wird nicht umgesetzt':
                        tagColor = '#ef4444'; // red
                        tagIcon = '✗';
                        break;
                    case 'wird geprüft':
                        tagColor = '#f59e0b'; // orange
                        tagIcon = '⏳';
                        break;
                }

                tagBadge = `
                    <div style="margin-top: 8px;">
                        <span style="display: inline-flex; align-items: center; gap: 4px; background: ${tagColor}; color: white; padding: 4px 10px; border-radius: 6px; font-size: 0.8rem; font-weight: 500;">
                            <span>${tagIcon}</span>
                            <span>${this.escapeHtml(suggestion.tag)}</span>
                        </span>
                    </div>
                `;
            }

            return `
                <div class="suggestion-card">
                    <div class="suggestion-header">
                        <div class="suggestion-content">
                            <h3 class="suggestion-title">${this.escapeHtml(suggestion.title)}</h3>
                            <p class="suggestion-description">${this.escapeHtml(suggestion.description)}</p>
                            ${tagBadge}
                        </div>
                    </div>
                    <div class="suggestion-footer">
                        <div class="vote-info">
                            <span class="vote-count">${suggestion.votes || 0}</span>
                            <span>Vote${(suggestion.votes || 0) !== 1 ? 's' : ''}</span>
                        </div>
                        <button
                            class="vote-btn ${suggestion.hasVoted ? 'voted' : ''}"
                            ${suggestion.hasVoted ? 'disabled' : ''}
                            onclick="app.voteSuggestion('${suggestion.id}', this)"
                        >
                            ${suggestion.hasVoted ? 'Gevotet ✓' : 'Vote'}
                        </button>
                    </div>
                </div>
            `;
        }).join('');
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
        if (!timestamp) return '';
        const date = new Date(timestamp.seconds * 1000);
        return date.toLocaleDateString('de-DE', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    showSuccessOverlay() {
        const overlay = document.getElementById('successOverlay');
        overlay.style.display = 'flex';
        // Prevent body scroll
        document.body.style.overflow = 'hidden';
    }

    closeSuccessOverlay() {
        const overlay = document.getElementById('successOverlay');
        overlay.style.display = 'none';
        // Restore body scroll
        document.body.style.overflow = '';
        // Navigate back to suggestions
        this.showSuggestions();
    }
}

// Initialize the app
const app = new VotingApp();