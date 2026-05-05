const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiIndex = fs.readFileSync(path.join(rootDir, 'api', 'index.js'), 'utf8');
const adminScript = fs.readFileSync(path.join(rootDir, 'public', 'admin.js'), 'utf8');
const publicScript = fs.readFileSync(path.join(rootDir, 'public', 'script.js'), 'utf8');

test('suggestion workflows expose im Test across backend, admin, and public UI', () => {
  assert.ok(
    apiIndex.includes("const FEATURE_STATUSES = ['neu', 'wird geprüft', 'wird umgesetzt', 'im Test', 'ist umgesetzt', 'wird nicht umgesetzt'];"),
    'expected backend feature status validation to allow im Test'
  );

  assert.ok(
    apiIndex.includes("const FEATURE_TAGS = ['wird umgesetzt', 'im Test', 'wird nicht umgesetzt', 'wird geprüft', 'ist umgesetzt'];"),
    'expected legacy feature tags to preserve im Test'
  );

  assert.ok(
    apiIndex.includes("const TICKET_STATUSES = ['neu', 'offen', 'in Bearbeitung', 'im Test', 'wartend', 'gelöst', 'geschlossen'];"),
    'expected backend ticket status validation to allow im Test'
  );

  assert.ok(
    adminScript.includes("static FEATURE_STATUSES = ['neu', 'wird geprüft', 'wird umgesetzt', 'im Test', 'ist umgesetzt', 'wird nicht umgesetzt'];"),
    'expected admin status select to offer im Test for features'
  );

  assert.ok(
    adminScript.includes("static TICKET_STATUSES = ['neu', 'offen', 'in Bearbeitung', 'im Test', 'wartend', 'gelöst', 'geschlossen'];"),
    'expected admin status select to offer im Test for tickets and bugs'
  );

  assert.ok(
    /'im Test':\s+\{ color: '#06b6d4', icon: '\\u2699' \}/.test(publicScript),
    'expected public status badges to style im Test'
  );

  assert.ok(
    publicScript.includes("'im Test': { label: 'Im Test', color: '#06b6d4' }"),
    'expected public status filters to label im Test'
  );

  assert.ok(
    apiIndex.includes("case 'im Test': return 'in analyse';"),
    'expected legacy tag mapping to keep im Test in the active bug/ticket bucket'
  );
});
