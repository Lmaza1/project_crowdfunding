#!/usr/bin/env node
// Builds workflow.json (importable into n8n) from src/*.js and copy.json.
// Run after any change to the code or the copy:  node scripts/build-workflow.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// Turn a CommonJS file whose last statement is `module.exports = {...};`
// into an expression usable inside an n8n Code node.
function inline(file) {
  const src = read(file);
  const m = src.match(/\nmodule\.exports\s*=\s*(\{[^}]*\});\s*$/);
  if (!m) throw new Error(`${file}: module.exports must be the last statement`);
  return `(() => {\n${src.slice(0, m.index)}\nreturn ${m[1]};\n})()`;
}

const copy = JSON.parse(read('copy.json'));
const CORE = inline('src/core.js');
const ACT = inline('src/act.js');

const verifyCode = `// Meta webhook verification handshake (GET).
const q = $input.first().json.query || {};
const ok = q['hub.mode'] === 'subscribe' && $env.META_VERIFY_TOKEN && q['hub.verify_token'] === $env.META_VERIFY_TOKEN;
return [{ json: { status: ok ? 200 : 403, body: ok ? String(q['hub.challenge']) : 'forbidden' } }];`;

const routeCode = `// GENERATED from src/core.js + copy.json by scripts/build-workflow.js. Edit those, then rebuild.
const crypto = require('crypto');
const fs = require('fs');
const core = ${CORE};
const COPY = ${JSON.stringify(copy, null, 2)};

const env = $env;
const LOG = env.LOG_CSV_PATH || '/home/node/.n8n/logs/autoreply-log.csv';
function log(fields) {
  fs.mkdirSync(require('path').dirname(LOG), { recursive: true });
  if (!fs.existsSync(LOG)) fs.appendFileSync(LOG, core.csvRow(core.LOG_COLUMNS));
  fs.appendFileSync(LOG, core.csvRow(fields));
}

const input = $input.first();
const headers = input.json.headers || {};
let raw = null;
try { raw = await this.helpers.getBinaryDataBuffer(0, 'data'); } catch (_) {}
if (env.SKIP_SIGNATURE_CHECK !== 'true') {
  if (!raw || !core.verifySignature(raw, headers['x-hub-signature-256'], env.META_APP_SECRET, crypto)) {
    log([new Date().toISOString(), 'rejected', '', '', '', '', '', '', '', '', '', '', 'bad_signature', '', '', '', '', '', '', raw ? 'signature mismatch' : 'no raw body']);
    return [];
  }
}
let body = input.json.body;
if (raw) { try { body = JSON.parse(raw.toString('utf8')); } catch (_) {} }

const mode = ['off', 'dry_run', 'live'].includes(env.AUTOREPLY_MODE) ? env.AUTOREPLY_MODE : 'dry_run';
if (mode === 'off') return [];

const sd = $getWorkflowStaticData('global');
sd.seen = core.pruneSeen(sd.seen || {}, Date.now());
const testIds = (env.TEST_ONLY_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const opts = {
  accounts: core.loadAccounts(env), copy: COPY, mode, seen: sd.seen, now: new Date(),
  testOnlyUserIds: testIds.length ? new Set(testIds) : null,
};

const out = [];
for (const ev of core.parseEvents(body)) {
  const d = core.decide(ev, opts);
  if (!d) continue;
  sd.seen[ev.commentId] = Date.now();
  out.push({ json: d });
}
return out;`;

const actCode = `// GENERATED from src/act.js + src/core.js by scripts/build-workflow.js. Edit those, then rebuild.
const fs = require('fs');
const core = ${CORE};
const { act } = ${ACT};

const env = $env;
const LOG = env.LOG_CSV_PATH || '/home/node/.n8n/logs/autoreply-log.csv';
const http = (o) => this.helpers.httpRequest({ method: o.method, url: o.url, qs: o.qs, body: o.body, json: true });

const results = [];
for (const it of $input.all()) {
  const d = it.json;
  const token = env[d.brand.toUpperCase() + '_PAGE_TOKEN'];
  const r = await act(d, { http, env, token });
  fs.mkdirSync(require('path').dirname(LOG), { recursive: true });
  if (!fs.existsSync(LOG)) fs.appendFileSync(LOG, core.csvRow(core.LOG_COLUMNS));
  fs.appendFileSync(LOG, core.csvRow([
    new Date().toISOString(), d.mode, d.brand, d.platform, d.accountId, d.postId, d.commentId, d.parentId,
    d.fromId, d.fromName, d.fromUsername, d.text, d.action, d.variant, d.dmText, r.dm_status,
    d.publicText, r.public_status, r.alert_status, d.note,
  ]));
  results.push({ json: { ...d, ...r } });
}
return results;`;

const PATH = 'meta-comments';
const workflow = {
  name: 'Comment auto-reply — ConstruR3 + Vas con Maz',
  nodes: [
    { id: 'a1f0c6d2-0001-4b7e-9a10-000000000001', name: 'Meta verify (GET)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0],
      webhookId: 'b7d3a0e4-5c1f-4f0e-8d2a-6a1e2f3c4d01',
      parameters: { httpMethod: 'GET', path: PATH, responseMode: 'responseNode', options: {} } },
    { id: 'a1f0c6d2-0002-4b7e-9a10-000000000002', name: 'Check verify token', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0],
      parameters: { mode: 'runOnceForAllItems', jsCode: verifyCode } },
    { id: 'a1f0c6d2-0003-4b7e-9a10-000000000003', name: 'Answer challenge', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [440, 0],
      parameters: { respondWith: 'text', responseBody: '={{ $json.body }}', options: { responseCode: '={{ $json.status }}' } } },
    { id: 'a1f0c6d2-0004-4b7e-9a10-000000000004', name: 'Meta comment event (POST)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 240],
      webhookId: 'b7d3a0e4-5c1f-4f0e-8d2a-6a1e2f3c4d02',
      parameters: { httpMethod: 'POST', path: PATH, responseMode: 'onReceived', options: { rawBody: true } } },
    { id: 'a1f0c6d2-0005-4b7e-9a10-000000000005', name: 'Verify, filter, pick copy', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 240],
      parameters: { mode: 'runOnceForAllItems', jsCode: routeCode } },
    { id: 'a1f0c6d2-0006-4b7e-9a10-000000000006', name: 'Human-ish delay 30–90 s', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [440, 240],
      parameters: { resume: 'timeInterval', amount: '={{ 30 + Math.floor(Math.random() * 61) }}', unit: 'seconds' } },
    { id: 'a1f0c6d2-0007-4b7e-9a10-000000000007', name: 'DM, public reply, alert, log', type: 'n8n-nodes-base.code', typeVersion: 2, position: [660, 240],
      parameters: { mode: 'runOnceForAllItems', jsCode: actCode } },
  ],
  connections: {
    'Meta verify (GET)': { main: [[{ node: 'Check verify token', type: 'main', index: 0 }]] },
    'Check verify token': { main: [[{ node: 'Answer challenge', type: 'main', index: 0 }]] },
    'Meta comment event (POST)': { main: [[{ node: 'Verify, filter, pick copy', type: 'main', index: 0 }]] },
    'Verify, filter, pick copy': { main: [[{ node: 'Human-ish delay 30–90 s', type: 'main', index: 0 }]] },
    'Human-ish delay 30–90 s': { main: [[{ node: 'DM, public reply, alert, log', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1', timezone: 'America/Guatemala', saveDataSuccessExecution: 'all' },
  pinData: {},
};

fs.writeFileSync(path.join(root, 'workflow.json'), JSON.stringify(workflow, null, 2) + '\n');
console.log(`workflow.json written (copy approved: ${copy.approved})`);
