'use strict';

// mcp/start.sh liest den API-Schlüssel aus dem Schlüsselbund und startet den
// Server. `security` und `node` sind Attrappen im PATH: Der echte
// Schlüsselbund wird nie gelesen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'mcp', 'start.sh');
const SERVICE = 'roadlight-intern-api';
const KEY = 'vt_live_nur-ein-testwert';

// Antwortet nur auf genau diese Abfrage; ohne FAKE_FOUND wie ein fehlender
// Eintrag (Status 44 und Meldung auf stderr).
const FAKE_SECURITY = `#!/bin/bash
if [ "$*" != "find-generic-password -s ${SERVICE} -w" ]; then echo "unerwartet: $*" >&2; exit 2; fi
if [ -z "\${FAKE_FOUND:-}" ]; then echo "security: item not found" >&2; exit 44; fi
printf '%s\\n' "\${FAKE_KEY:-}"
`;

const FAKE_NODE = `#!/bin/bash
printf '%s\\n%s\\n' "$VOTING_TOOL_API_KEY" "$*" > "$FAKE_NODE_LOG"
`;

function start(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-start-'));
  try {
    for (const [name, content] of [['security', FAKE_SECURITY], ['node', FAKE_NODE]]) {
      fs.writeFileSync(path.join(dir, name), content, { mode: 0o755 });
    }
    const nodeLog = path.join(dir, 'node.log');
    // Direkt aufgerufen: prüft zugleich Ausführrecht und Shebang.
    const result = spawnSync(SCRIPT, [], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
      env: { PATH: `${dir}:/usr/bin:/bin`, FAKE_NODE_LOG: nodeLog, ...env },
    });
    const node = fs.existsSync(nodeLog) ? fs.readFileSync(nodeLog, 'utf8').trim().split('\n') : null;
    return { ...result, node };
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

for (const [why, env] of [
  ['ohne Eintrag', {}],
  ['bei leerem Eintrag', { FAKE_FOUND: '1', FAKE_KEY: '' }],
]) {
  test(`${why}: Meldung nennt den Dienst, node startet nicht`, () => {
    const result = start(env);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(SERVICE));
    assert.match(result.stderr, /security add-generic-password/);
    assert.equal(result.stdout, '', 'stdout gehört dem MCP-Protokoll');
    assert.equal(result.node, null);
  });
}

test('mit Eintrag: node bekommt den Schlüssel, ausgegeben wird er nie', () => {
  const result = start({ FAKE_FOUND: '1', FAKE_KEY: KEY });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.node, [KEY, path.join(path.dirname(SCRIPT), 'server.js')]);
  assert.equal(result.stdout.includes(KEY), false);
  assert.equal(result.stderr.includes(KEY), false);
});
