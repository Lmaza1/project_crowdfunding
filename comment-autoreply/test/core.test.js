const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../src/core');
const { act, parseWhatsApp, redact } = require('../src/act');
const copy = require('../copy.json');

const ENV = {
  CONSTRUR3_PAGE_ID: '111', CONSTRUR3_IG_ID: '1784111', CONSTRUR3_PAGE_TOKEN: 'tokC',
  VASCONMAZ_PAGE_ID: '222', VASCONMAZ_IG_ID: '1784222', VASCONMAZ_PAGE_TOKEN: 'tokV',
};
const accounts = core.loadAccounts(ENV);
const approved = { ...copy, approved: true };

const fbBody = (o = {}) => ({ object: 'page', entry: [{ id: '111', changes: [{ field: 'feed', value: {
  item: 'comment', verb: 'add', comment_id: '111_999', post_id: '111_5', parent_id: '111_5',
  message: 'Cuánto cuesta remodelar una cocina?', from: { id: '555', name: 'maría josé López' }, ...o } }] }] });
const igBody = (o = {}) => ({ object: 'instagram', entry: [{ id: '1784222', changes: [{ field: 'comments', value: {
  id: '17900', text: 'Info por favor', from: { id: '777', username: 'empresa_gt' }, media: { id: '1790m' }, ...o } }] }] });

test('signature: valid, tampered, missing', () => {
  const raw = Buffer.from(JSON.stringify(fbBody()));
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.ok(core.verifySignature(raw, sig, 's3cret', crypto));
  assert.ok(!core.verifySignature(Buffer.from(raw.toString() + ' '), sig, 's3cret', crypto));
  assert.ok(!core.verifySignature(raw, undefined, 's3cret', crypto));
  assert.ok(!core.verifySignature(raw, 'sha256=abc', 's3cret', crypto));
});

test('parse: FB comment add, ignores likes/edits/removes', () => {
  const [e] = core.parseEvents(fbBody());
  assert.deepStrictEqual([e.platform, e.accountId, e.commentId, e.parentId, e.fromName], ['facebook', '111', '111_999', null, 'maría josé López']);
  assert.strictEqual(core.parseEvents(fbBody({ verb: 'edited' })).length, 0);
  assert.strictEqual(core.parseEvents(fbBody({ verb: 'remove' })).length, 0);
  assert.strictEqual(core.parseEvents(fbBody({ item: 'reaction' })).length, 0);
});

test('parse: IG comment, no name from a username', () => {
  const [e] = core.parseEvents(igBody());
  assert.strictEqual(e.platform, 'instagram');
  assert.strictEqual(e.fromName, null);
  assert.strictEqual(e.fromUsername, 'empresa_gt');
});

test('FB comment -> ConstruR3 tú copy, first name, DM + public', () => {
  const d = core.decide(core.parseEvents(fbBody())[0], { accounts, copy: approved, mode: 'live', seen: {} });
  assert.strictEqual(d.brand, 'construr3');
  assert.strictEqual(d.action, 'reply');
  assert.strictEqual(d.mode, 'live');
  assert.match(d.dmText, /^¡Hola, María! Te escribimos de ConstruR3/);
  assert.ok(copy.brands.construr3.public.map((t) => core.render(t, { nombre: 'María' })).includes(d.publicText));
  assert.ok(!/\{|\}/.test(d.publicText + d.dmText));
});

test('IG comment -> Vas con Maz usted copy, name dropped cleanly', () => {
  const d = core.decide(core.parseEvents(igBody())[0], { accounts, copy: approved, mode: 'live', seen: {}, now: new Date('2026-11-14T20:00:00Z') });
  assert.strictEqual(d.brand, 'vasconmaz');
  assert.match(d.dmText, /^Buenas tardes\. Le escribimos de Vas con Maz/);
  assert.ok(!/\{|\}|,\s*[.!]|\s{2}/.test(d.publicText + d.dmText), d.publicText);
});

test('render without name: every template reads cleanly', () => {
  for (const b of Object.values(copy.brands)) {
    for (const t of [...b.public, b.dm, b.recovery_dm]) {
      const s = core.render(t, {});
      assert.ok(!/\{nombre\}|,\s*[.!?]|\s{2}|^\s|^[a-zñ]/.test(s), s);
    }
  }
  assert.strictEqual(core.render('{nombre}, gracias por comentar.', {}), 'Gracias por comentar.');
  assert.strictEqual(core.render('¡Gracias, {nombre}! Hola.', {}), '¡Gracias! Hola.');
  assert.strictEqual(core.render('{saludo}, {nombre}.', { saludo: 'Buenos días' }), 'Buenos días.');
});

test('own comments, unknown accounts, duplicates are ignored', () => {
  const opts = { accounts, copy: approved, mode: 'live', seen: { '111_999': Date.now() } };
  assert.strictEqual(core.decide(core.parseEvents(fbBody())[0], opts), null);
  opts.seen = {};
  assert.strictEqual(core.decide(core.parseEvents(fbBody({ from: { id: '111', name: 'ConstruR3' } }))[0], opts), null);
  assert.strictEqual(core.decide(core.parseEvents(igBody({ from: { id: '1784222', username: 'vasconmaz' } }))[0], opts), null);
  const other = fbBody(); other.entry[0].id = '999';
  assert.strictEqual(core.decide(core.parseEvents(other)[0], opts), null);
});

test('complaints -> recovery DM, no public reply', () => {
  for (const text of ['Son unos ESTAFADORES', 'pésimo servicio, nunca terminaron la obra', 'No se los recomiendo', 'nadie me contesta desde hace un mes', 'Cuidado con esta empresa']) {
    const d = core.decide(core.parseEvents(fbBody({ message: text }))[0], { accounts, copy: approved, mode: 'live', seen: {} });
    assert.strictEqual(d.action, 'recovery', text);
    assert.strictEqual(d.publicText, null);
    assert.match(d.dmText, /^Lamentamos tu experiencia, María/);
  }
  for (const text of ['No me entregaron el trabajo', 'Me cobraron de más', 'dejaron la obra a medias']) {
    assert.ok(core.isNegative(text), text);
  }
  for (const text of ['Qué bonito quedó 😍', 'Precio?', 'No tengo ninguna queja, excelente trabajo',
    'Tengo una filtración en el techo, ¿la reparan?', 'Se me rajó la pared, cotizan?', 'lo peor fue decidir el color jaja']) {
    assert.ok(!core.isNegative(text), text);
  }
});

test('approval gate and test allow-list force dry_run', () => {
  const ev = core.parseEvents(fbBody())[0];
  assert.strictEqual(core.decide(ev, { accounts, copy, mode: 'live', seen: {} }).mode, 'dry_run');
  const t = core.decide(ev, { accounts, copy: approved, mode: 'live', seen: {}, testOnlyUserIds: new Set(['123']) });
  assert.strictEqual(t.mode, 'dry_run');
  assert.strictEqual(core.decide(ev, { accounts, copy: approved, mode: 'live', seen: {}, testOnlyUserIds: new Set(['555']) }).mode, 'live');
});

test('saludo follows Guatemala time (UTC-6)', () => {
  assert.strictEqual(core.saludo(new Date('2026-11-14T15:00:00Z')), 'Buenos días');
  assert.strictEqual(core.saludo(new Date('2026-11-14T20:00:00Z')), 'Buenas tardes');
  assert.strictEqual(core.saludo(new Date('2026-11-15T03:00:00Z')), 'Buenas noches');
});

test('variants rotate across comments and are stable per comment', () => {
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(core.pickVariant('111_' + i, 3));
  assert.strictEqual(seen.size, 3);
  assert.strictEqual(core.pickVariant('abc', 3), core.pickVariant('abc', 3));
});

function recorder(failOn) {
  const calls = [];
  const http = async (o) => {
    calls.push(o);
    if (failOn && o.url.includes(failOn)) { const e = new Error('x'); e.response = { body: { error: { code: 10, message: 'outside allowed window' } } }; throw e; }
    return { id: 'ok', permalink: 'https://instagram.com/p/x' };
  };
  return { calls, http };
}

test('act live FB: DM to /page/messages first, then /comment/comments', async () => {
  const d = core.decide(core.parseEvents(fbBody())[0], { accounts, copy: approved, mode: 'live', seen: {} });
  const { calls, http } = recorder();
  const r = await act(d, { http, env: {}, token: 'tokC' });
  assert.deepStrictEqual(r, { dm_status: 'sent', public_status: 'sent', alert_status: '' });
  assert.strictEqual(calls[0].url, 'https://graph.facebook.com/v24.0/111/messages');
  assert.deepStrictEqual(calls[0].body.recipient, { comment_id: '111_999' });
  assert.strictEqual(calls[1].url, 'https://graph.facebook.com/v24.0/111_999/comments');
  assert.strictEqual(calls[1].headers.Authorization, 'Bearer tokC');
  assert.ok(!calls.some((c) => JSON.stringify(c.qs || {}).includes('tokC')), 'token never in the URL');
});

test('act live IG: public reply uses /replies; DM failure skips public + alerts', async () => {
  const d = core.decide(core.parseEvents(igBody())[0], { accounts, copy: approved, mode: 'live', seen: {} });
  const ok = recorder();
  await act(d, { http: ok.http, env: {}, token: 'tokV' });
  assert.strictEqual(ok.calls[0].url, 'https://graph.facebook.com/v24.0/222/messages');
  assert.strictEqual(ok.calls[1].url, 'https://graph.facebook.com/v24.0/17900/replies');
  const bad = recorder('/messages');
  const r = await act(d, { http: bad.http, env: { ALERT_WEBHOOK_URL: 'https://hooks.example/x' }, token: 'tokV' });
  assert.match(r.dm_status, /graph error 10/);
  assert.strictEqual(r.public_status, 'skipped: dm failed');
  assert.strictEqual(r.alert_status, 'webhook sent');
});

test('audit #1: dry_run makes ZERO outbound calls, alerts included', async () => {
  const env = { ALERT_WEBHOOK_URL: 'https://hooks.example/x', ALERT_WHATSAPP: '50212345678:111' };
  for (const message of ['son una estafa', 'precio?']) {
    const d = core.decide(core.parseEvents(fbBody({ message }))[0], { accounts, copy, mode: 'live', seen: {} });
    assert.strictEqual(d.mode, 'dry_run');
    const { calls, http } = recorder();
    const r = await act(d, { http, env, token: 'tokC' });
    assert.strictEqual(calls.length, 0, message);
    assert.strictEqual(r.dm_status, 'dry_run');
  }
});

test('audit #4: errors are redacted before logging', async () => {
  assert.strictEqual(redact('GET https://x/?phone=1&apikey=999&access_token=EAAB123 failed', []), 'GET https://x/?phone=1&apikey=[redacted]&access_token=[redacted] failed');
  assert.strictEqual(redact('boom EAABsecret boom', ['EAABsecret']), 'boom [redacted] boom');
  const d = core.decide(core.parseEvents(fbBody())[0], { accounts, copy: approved, mode: 'live', seen: {} });
  const http = async () => { throw new Error('connect failed https://graph.facebook.com/x?access_token=tokC'); };
  const r = await act(d, { http, env: {}, token: 'tokC', sleep: async () => {} });
  assert.ok(!r.dm_status.includes('tokC'), r.dm_status);
});

test('transient errors are retried, permanent ones are not', async () => {
  const d = core.decide(core.parseEvents(fbBody())[0], { accounts, copy: approved, mode: 'live', seen: {} });
  let n = 0;
  const flaky = async () => { if (++n === 1) { const e = new Error('x'); e.response = { body: { error: { code: 2, message: 'temporary' } } }; throw e; } return {}; };
  const r = await act(d, { http: flaky, env: {}, token: 't', sleep: async () => {} });
  assert.strictEqual(r.dm_status, 'sent');
  const bad = recorder('/messages');
  await act(d, { http: bad.http, env: {}, token: 't', sleep: async () => {} });
  assert.strictEqual(bad.calls.length, 1, 'code 10 is permanent: no retry');
});

test('audit #5: DM ok but public reply failed -> alert', async () => {
  const d = core.decide(core.parseEvents(igBody())[0], { accounts, copy: approved, mode: 'live', seen: {} });
  const { calls, http } = recorder('/replies');
  const r = await act(d, { http, env: { ALERT_WHATSAPP: '50212345678:111' }, token: 'tokV' });
  assert.strictEqual(r.dm_status, 'sent');
  assert.match(r.public_status, /^error/);
  assert.strictEqual(r.alert_status, 'wa:5678 sent');
  assert.match(calls.at(-1).qs.text, /^DM enviado, pero falló la respuesta pública/);
});

test('VcM DM greeting follows time of day', () => {
  const ev = core.parseEvents(igBody())[0];
  const at = (iso) => core.decide(ev, { accounts, copy: approved, mode: 'live', seen: {}, now: new Date(iso) }).dmText;
  assert.match(at('2026-11-14T15:00:00Z'), /^Buenos días\. Le escribimos/);
  assert.match(at('2026-11-15T03:00:00Z'), /^Buenas noches\. Le escribimos/);
});

test('WhatsApp alerts via CallMeBot to every recipient', async () => {
  assert.deepStrictEqual(parseWhatsApp(' +502 1234-5678:111 , 50287654321:222,bad'), [
    { phone: '50212345678', apikey: '111' }, { phone: '50287654321', apikey: '222' }]);
  const d = core.decide(core.parseEvents(fbBody({ message: 'pésimo servicio' }))[0], { accounts, copy: approved, mode: 'live', seen: {} });
  const { calls, http } = recorder();
  const r = await act(d, { http, env: { ALERT_WHATSAPP: '50212345678:111,50287654321:222' }, token: 'tokC' });
  const wa = calls.filter((c) => c.url === 'https://api.callmebot.com/whatsapp.php');
  assert.strictEqual(wa.length, 2);
  assert.deepStrictEqual(wa.map((c) => c.qs.apikey), ['111', '222']);
  assert.match(wa[0].qs.text, /^Comentario negativo — construr3 \(facebook\)/);
  assert.strictEqual(r.alert_status, 'wa:5678 sent; wa:4321 sent');
});

test('csv escaping', () => {
  assert.strictEqual(core.csvRow(['a', 'b,c', 'd"e', null, 'x\ny']), 'a,"b,c","d""e",,"x\ny"\n');
  assert.strictEqual(core.csvRow(['=HYPERLINK("http://x")', '+1', '@a', '-2']), '"\'=HYPERLINK(""http://x"")",\'+1,\'@a,\'-2\n');
});

// Runs the generated n8n Code nodes from workflow.json in a fake n8n runtime.
test('workflow.json Code nodes run end-to-end in a simulated n8n runtime', async () => {
  require('child_process').execFileSync('node', [path.join(__dirname, '../scripts/build-workflow.js')]);
  const wf = JSON.parse(fs.readFileSync(path.join(__dirname, '../workflow.json'), 'utf8'));
  const code = (name) => wf.nodes.find((n) => n.name === name).parameters.jsCode;
  const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
  const run = (src, ctx, input) => new AsyncFn('$input', '$env', '$getWorkflowStaticData', 'require', src)
    .call(ctx, { first: () => input[0], all: () => input }, ctx.env, () => ctx.static, require);

  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')), 'log.csv');
  const env = { ...ENV, META_APP_SECRET: 's3cret', META_VERIFY_TOKEN: 'vt', AUTOREPLY_MODE: 'live', LOG_CSV_PATH: logFile };

  const v = await run(code('Check verify token'), { env }, [{ json: { query: { 'hub.mode': 'subscribe', 'hub.verify_token': 'vt', 'hub.challenge': '42' } } }]);
  assert.deepStrictEqual(v[0].json, { status: 200, body: '42' });

  const raw = Buffer.from(JSON.stringify(fbBody()));
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  const calls = [];
  const ctx = { env, static: {}, helpers: {
    getBinaryDataBuffer: async () => raw,
    httpRequest: async (o) => { calls.push(o); return { id: 'ok' }; },
  } };
  const routed = await run(code('Verify, filter, pick copy'), ctx, [{ json: { headers: { 'x-hub-signature-256': sig }, body: {} } }]);
  assert.strictEqual(routed.length, 1);
  assert.strictEqual(routed[0].json.mode, 'dry_run', 'copy.json is not approved, so live must be forced to dry_run');
  const again = await run(code('Verify, filter, pick copy'), ctx, [{ json: { headers: { 'x-hub-signature-256': sig }, body: {} } }]);
  assert.strictEqual(again.length, 0, 'duplicate delivery is dropped');

  const done = await run(code('DM, public reply, alert, log'), ctx, routed);
  assert.strictEqual(done[0].json.dm_status, 'dry_run');
  assert.strictEqual(calls.length, 0);
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  assert.match(lines[1], /dry_run,construr3,facebook,111/);

  // audit #2 + #3: live item re-gated at send time, and one durable claim per comment
  const liveAct = code('DM, public reply, alert, log').replace('const COPY_APPROVED = false;', 'const COPY_APPROVED = true;');
  assert.notStrictEqual(liveAct, code('DM, public reply, alert, log'));
  const claimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-'));
  const liveItem = [{ json: { ...routed[0].json, mode: 'live', note: null } }];
  const offCtx = { ...ctx, env: { ...env, AUTOREPLY_MODE: 'off', CLAIM_DIR: claimDir } };
  const off = await run(liveAct, offCtx, liveItem);
  assert.strictEqual(off[0].json.mode, 'off', 'switch turned off during the wait -> nothing sent');
  const narrowed = await run(liveAct, { ...ctx, env: { ...env, TEST_ONLY_USER_IDS: '123', CLAIM_DIR: claimDir } }, liveItem);
  assert.strictEqual(narrowed[0].json.mode, 'dry_run');
  assert.strictEqual(calls.length, 0);
  const liveCtx = { ...ctx, env: { ...env, CLAIM_DIR: claimDir } };
  const [first, second] = await Promise.all([run(liveAct, liveCtx, liveItem), run(liveAct, liveCtx, liveItem)]);
  assert.deepStrictEqual([first[0].json.mode, second[0].json.mode].sort(), ['duplicate', 'live']);
  assert.strictEqual(calls.filter((c) => c.url.endsWith('/messages')).length, 1, 'exactly one DM');

  const forged = await run(code('Verify, filter, pick copy'), { ...ctx, static: {} }, [{ json: { headers: { 'x-hub-signature-256': 'sha256=00' }, body: {} } }]);
  assert.strictEqual(forged.length, 0);
});
