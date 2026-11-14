// Pure logic for the comment auto-reply. No I/O here: everything the n8n Code
// nodes need is passed in, so this file is unit-tested in Node and inlined
// verbatim into workflow.json by scripts/build-workflow.js.
// Keep it dependency-free and keep `module.exports` as the LAST statement.

const BRANDS = ['construr3', 'vasconmaz'];

// --- Meta webhook signature (X-Hub-Signature-256: sha256=<hex HMAC of raw body>)
function verifySignature(rawBody, header, appSecret, crypto) {
  if (!header || !appSecret || !rawBody) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Account map from env: which Page / IG account belongs to which brand.
function loadAccounts(env) {
  const accounts = {};
  for (const brand of BRANDS) {
    const up = brand.toUpperCase();
    const token = env[`${up}_PAGE_TOKEN`];
    const pageId = env[`${up}_PAGE_ID`];
    const igId = env[`${up}_IG_ID`];
    if (pageId) accounts[`facebook:${pageId}`] = { brand, platform: 'facebook', accountId: pageId, pageId, token };
    if (igId) accounts[`instagram:${igId}`] = { brand, platform: 'instagram', accountId: igId, pageId, token };
  }
  return accounts;
}

// --- Normalise a webhook body into comment events.
// Page:      {object:'page', entry:[{id, changes:[{field:'feed', value:{item:'comment', verb:'add', comment_id, post_id, parent_id, message, from:{id,name}}}]}]}
// Instagram: {object:'instagram', entry:[{id, changes:[{field:'comments', value:{id, text, from:{id,username}, media:{id}, parent_id}}]}]}
function parseEvents(body) {
  const out = [];
  if (!body || !Array.isArray(body.entry)) return out;
  for (const entry of body.entry) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      if (body.object === 'page' && change.field === 'feed') {
        if (v.item !== 'comment' || v.verb !== 'add') continue;
        out.push({
          platform: 'facebook',
          accountId: String(entry.id),
          commentId: v.comment_id,
          postId: v.post_id || null,
          parentId: v.parent_id && v.parent_id !== v.post_id ? v.parent_id : null,
          text: v.message || '',
          fromId: v.from && v.from.id ? String(v.from.id) : null,
          fromName: (v.from && v.from.name) || null,
        });
      } else if (body.object === 'instagram' && change.field === 'comments') {
        out.push({
          platform: 'instagram',
          accountId: String(entry.id),
          commentId: v.id,
          postId: (v.media && v.media.id) || null,
          parentId: v.parent_id || null,
          text: v.text || '',
          fromId: v.from && v.from.id ? String(v.from.id) : null,
          fromName: null, // IG only gives a username; we never greet people by handle
          fromUsername: (v.from && v.from.username) || null,
        });
      }
    }
  }
  return out.filter((e) => e.commentId);
}

function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// Complaint / anger patterns (Spanish, accent-insensitive). Matching any of
// these routes the comment to the service-recovery DM + human alert instead
// of the public sales reply.
const NEGATIVE_PATTERNS = [
  /\bestaf/, /\bfraud/, /\bladron/, /\brob(o|aron|an)\b/, /\bengan/, /\bmentir/, /\bmentiros/,
  /\bpesim/, /\bmalisim/, /\bmal servicio\b/, /\bmala (atencion|calidad|experiencia)\b/,
  /\bterrible/, /\bhorrible/, /\bbasura\b/, /\bpeor(es)?\b/, /\bdecepcion/, /\bdecepcionad/,
  /\bqueja/, /\bdenunci/, /\bdemand/, /\babogad/, /\breembols/, /\bdevuelv/, /\bdevolucion/,
  /\bincumpl/, /\bno (me )?cumpl/, /\bnunca (terminaron|llegaron|cumplieron|vinieron|contestaron|respondieron)/,
  /\bno (me )?(responden|contestan|han respondido|han contestado)/, /\bnadie (me )?(responde|contesta)/,
  /\bcuidado con\b/, /\bno (se los |lo |los )?recomiendo\b/, /\birresponsabl/, /\bsinverguenza/,
  /\bratas?\b/, /\bchapuz/, /\bmal hech/, /\bmal trabajo\b/,
  /\bno (me )?(entregaron|terminaron|cumplieron|devolvieron|regresaron|vinieron)/, /\bnunca (me )?entregaron/,
  /\b(me|nos) (cobraron|cobran) (de mas|demas|mas de lo)/, /\bcobro de mas\b/, /\bsobrecobr/,
  /\b(se|nos|me) (dejaron|dejo) (tirad|botad|abandonad|a medias)/, /\bobra (abandonada|a medias)\b/,
  /\bdinero (perdido|tirado)\b/, /\bperd(i|imos) (mi|el|nuestro) dinero\b/,
];
// Phrases that contain a complaint word but aren't complaints ("ninguna queja").
// Repair requests ("tengo una filtración") are deliberately NOT complaints: they're leads.
const NEGATION_PATTERNS = [
  /\b(ninguna|sin|cero|nada de) (queja|reclamo)s?\b/, /\bno (tengo|tenemos|hay) (ninguna |queja|quejas|reclamo)/,
  /\b(lo|la) peor (es|fue) (decidir|elegir|esperar)/, /\bno (es|fue) (una )?estafa\b/,
];
function isNegative(text) {
  let t = normalize(text);
  for (const re of NEGATION_PATTERNS) t = t.replace(new RegExp(re.source, 'g'), ' ');
  return NEGATIVE_PATTERNS.some((re) => re.test(t));
}

// "Juan Carlos Pérez" -> "Juan". Rejects anything that doesn't look like a name.
function firstName(fullName) {
  if (!fullName) return null;
  const first = String(fullName).trim().split(/\s+/)[0];
  if (!first || first.length < 2 || !/^\p{L}[\p{L}'-]*$/u.test(first)) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Guatemala is UTC-6 all year (no DST).
function saludo(date) {
  const h = (date.getUTCHours() + 18) % 24;
  if (h >= 5 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

// Fill {nombre} / {saludo}. When there is no name, drop the name cleanly:
// "¡Gracias, {nombre}!" -> "¡Gracias!", "{nombre}, gracias…" -> "Gracias…".
function render(template, vars) {
  let s = String(template);
  if (vars.saludo) s = s.replace(/\{saludo\}/g, vars.saludo);
  if (vars.nombre) return s.replace(/\{nombre\}/g, vars.nombre);
  s = s.replace(/,\s*\{nombre\}/g, '');
  s = s.replace(/(^|[.!?¡¿]\s*)\{nombre\},?\s*(\p{L})/gu, (_, pre, ch) => pre + ch.toUpperCase());
  s = s.replace(/\s*\{nombre\}\s*/g, ' ');
  return s.replace(/\s{2,}/g, ' ').trim();
}

// Stable rotation: same comment always gets the same variant (idempotent retries),
// different comments spread across variants.
function pickVariant(commentId, n) {
  let h = 0;
  for (const ch of String(commentId)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % n;
}

// The single safety gate. 'live' only if the switch says live, the copy is
// approved, and (when a test list is set) the commenter is on it.
function gateMode(fromId, { mode, copy, testOnlyUserIds }) {
  if (mode === 'off') return { mode: 'off', note: 'AUTOREPLY_MODE=off' };
  if (mode !== 'live') return { mode: 'dry_run', note: null };
  if (!copy || copy.approved !== true) return { mode: 'dry_run', note: 'copy not approved: forced dry_run' };
  if (testOnlyUserIds && !testOnlyUserIds.has(fromId)) return { mode: 'dry_run', note: 'commenter not in TEST_ONLY_USER_IDS: dry_run' };
  return { mode: 'live', note: null };
}

function parseMode(v) { return ['off', 'dry_run', 'live'].includes(v) ? v : 'dry_run'; }
function parseTestIds(v) {
  const ids = String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  return ids.length ? new Set(ids) : null;
}

// Decide what to do with one event. Returns null for events to ignore.
// opts: { accounts, copy, mode: 'off'|'dry_run'|'live', seen: {commentId: ts}, now: Date, testOnlyUserIds: Set|null }
function decide(event, opts) {
  const acct = opts.accounts[`${event.platform}:${event.accountId}`];
  if (!acct) return null; // not one of our four accounts
  if (event.fromId && (event.fromId === acct.accountId || event.fromId === acct.pageId)) return null; // our own reply: avoid loops
  if (opts.seen && opts.seen[event.commentId]) return null; // one private reply per comment (Meta rule)

  const brandCopy = opts.copy.brands[acct.brand];
  const vars = { nombre: firstName(event.fromName), saludo: saludo(opts.now || new Date()) };
  const negative = isNegative(event.text);

  const { mode, note } = gateMode(event.fromId, opts);

  const base = { ...event, brand: acct.brand, pageId: acct.pageId, mode, note };
  if (negative) {
    return { ...base, action: 'recovery', publicText: null, dmText: render(brandCopy.recovery_dm, vars) };
  }
  const variant = pickVariant(event.commentId, brandCopy.public.length);
  return {
    ...base,
    action: 'reply',
    variant: variant + 1,
    publicText: render(brandCopy.public[variant], vars),
    dmText: render(brandCopy.dm, vars),
  };
}

// Drop dedupe entries older than Meta's 7-day private-reply window (+1 day slack).
function pruneSeen(seen, nowMs) {
  const cutoff = nowMs - 8 * 24 * 3600 * 1000;
  for (const k of Object.keys(seen)) if (seen[k] < cutoff) delete seen[k];
  return seen;
}

function csvRow(fields) {
  return fields.map((f) => {
    let s = f === null || f === undefined ? '' : String(f);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets running comment text as a formula
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',') + '\n';
}

const LOG_COLUMNS = ['timestamp', 'mode', 'brand', 'platform', 'account_id', 'post_id', 'comment_id', 'parent_id',
  'from_id', 'from_name', 'from_username', 'comment_text', 'action', 'variant', 'dm_text', 'dm_status',
  'public_text', 'public_status', 'alert_status', 'note'];

module.exports = { BRANDS, verifySignature, loadAccounts, parseEvents, normalize, isNegative, firstName, saludo, render, pickVariant, gateMode, parseMode, parseTestIds, decide, pruneSeen, csvRow, LOG_COLUMNS };
