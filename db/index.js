'use strict';

// Barrel: alle Repository-Module + Backend-Flag an einer Stelle.
// In api/index.js als `const repos = require('../db')` eingebunden.
module.exports = {
  backend: require('./backend'),
  tenants: require('./tenants'),
  apps: require('./apps'),
  votes: require('./votes'),
  suggestions: require('./suggestions'),
  comments: require('./comments'),
  releases: require('./releases'),
  activity: require('./activity'),
  users: require('./users'),
  memberships: require('./memberships'),
  invites: require('./invites'),
  sessions: require('./sessions'),
  loginLinks: require('./login-links'),
  apiKeys: require('./api-keys'),
  attachments: require('./attachments'),
};
