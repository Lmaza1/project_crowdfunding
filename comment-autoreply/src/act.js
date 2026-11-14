// Side effects for one decided item: private-reply DM, public reply, alert.
// `http({method, url, qs, body, headers})` must resolve to parsed JSON or throw.
// Inlined into workflow.json like core.js; keep `module.exports` LAST.
//
// Safety rule: unless item.mode === 'live', this makes NO outbound call at all
// (not Meta, not WhatsApp, not the alert webhook). Callers must re-run the gate
// (core.gateMode) right before calling act(), because an item can sit in the
// 30–90 s Wait while the switch is turned off.

function safeJson(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

// Remove anything secret-looking from a message before it is logged or alerted.
function redact(msg, secrets) {
  let s = String(msg);
  for (const sec of secrets || []) if (sec && sec.length >= 4) s = s.split(sec).join('[redacted]');
  return s.replace(/(access_token|apikey|appsecret_proof|token)=[^&\s"']+/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer [redacted]');
}

function graphError(e) {
  const r = e && (e.response || e.cause);
  const body = r && (r.body || r.data);
  return (body && (body.error || (typeof body === 'string' ? safeJson(body).error : null))) || null;
}

function errText(e, secrets) {
  const g = graphError(e);
  if (g) return redact(`graph error ${g.code}${g.error_subcode ? '/' + g.error_subcode : ''}: ${g.message}`, secrets).slice(0, 300);
  const status = e && (e.httpCode || e.statusCode || (e.response && e.response.status));
  return redact(`${status ? 'http ' + status + ': ' : ''}${(e && e.message) || e}`, secrets).slice(0, 300);
}

// Network errors, 5xx and Meta's temporary/rate-limit codes are worth a retry.
function isTransient(e) {
  const g = graphError(e);
  if (g) return [1, 2, 4, 17, 32, 341, 613].includes(Number(g.code)) || g.is_transient === true;
  const status = Number(e && (e.httpCode || e.statusCode || (e.response && e.response.status)));
  return !status || status >= 500 || status === 429;
}

async function withRetry(fn, sleep, delays = [2000, 6000]) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= delays.length || !isTransient(e)) throw e;
      await sleep(delays[i]);
    }
  }
}

function commentLink(item, permalink) {
  if (item.platform === 'facebook') return `https://www.facebook.com/${item.commentId}`;
  return permalink || `(Instagram media ${item.postId}, comment ${item.commentId})`;
}

// "50212345678:123456, +502 8765-4321:654321" -> [{phone:'50212345678', apikey:'123456'}, ...]
function parseWhatsApp(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.lastIndexOf(':');
    return { phone: x.slice(0, i).replace(/\D/g, ''), apikey: x.slice(i + 1).trim() };
  }).filter((r) => r.phone && r.apikey);
}

async function act(item, ctx) {
  const res = { dm_status: '', public_status: '', alert_status: '' };
  if (item.mode !== 'live') {
    res.dm_status = item.mode;
    if (item.action === 'reply') res.public_status = item.mode;
    if (item.action === 'recovery') res.alert_status = item.mode;
    return res;
  }

  const { http, env, token } = ctx;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const graph = `https://graph.facebook.com/${env.GRAPH_API_VERSION || 'v24.0'}`;
  const auth = { Authorization: `Bearer ${token}` };
  const whatsapp = parseWhatsApp(env.ALERT_WHATSAPP);
  const secrets = [token, env.META_APP_SECRET, ...whatsapp.map((w) => w.apikey)];
  const call = (o) => withRetry(() => http(o), sleep);

  // 1) Private reply first. The public reply promises a message, so it is only
  //    posted once the DM actually went out.
  try {
    await call({ method: 'POST', url: `${graph}/${item.pageId}/messages`, headers: auth,
      body: { recipient: { comment_id: item.commentId }, message: { text: item.dmText } } });
    res.dm_status = 'sent';
  } catch (e) {
    res.dm_status = 'error: ' + errText(e, secrets);
  }

  // 2) Public reply (not for complaints).
  if (item.action === 'reply') {
    if (res.dm_status !== 'sent') res.public_status = 'skipped: dm failed';
    else {
      const edge = item.platform === 'instagram' ? 'replies' : 'comments';
      try {
        await call({ method: 'POST', url: `${graph}/${item.commentId}/${edge}`, headers: auth, body: { message: item.publicText } });
        res.public_status = 'sent';
      } catch (e) {
        res.public_status = 'error: ' + errText(e, secrets);
      }
    }
  }

  // 3) Human alert: every complaint, any failed DM, any failed public reply.
  let why = null;
  if (item.action === 'recovery') why = 'Comentario negativo';
  else if (res.dm_status !== 'sent') why = 'No se pudo enviar el DM';
  else if (res.public_status !== 'sent') why = 'DM enviado, pero falló la respuesta pública';
  if (!why) return res;
  if (!whatsapp.length && !env.ALERT_WEBHOOK_URL) { res.alert_status = 'no alert channel configured'; return res; }

  let permalink = null;
  if (item.platform === 'instagram' && item.postId) {
    try { permalink = (await http({ method: 'GET', url: `${graph}/${item.postId}`, qs: { fields: 'permalink' }, headers: auth })).permalink; } catch (_) {}
  }
  const who = item.fromName || (item.fromUsername ? '@' + item.fromUsername : 'usuario');
  const text = `${why} — ${item.brand} (${item.platform})\n${who}: "${String(item.text).slice(0, 500)}"\n` +
    `${commentLink(item, permalink)}\nDM: ${res.dm_status}${item.action === 'reply' ? '\nPúblico: ' + res.public_status : ''}`;
  const statuses = [];
  for (const r of whatsapp) { // CallMeBot: one GET per recipient, each with their own apikey
    try {
      await call({ method: 'GET', url: 'https://api.callmebot.com/whatsapp.php', qs: { phone: r.phone, text, apikey: r.apikey } });
      statuses.push(`wa:${r.phone.slice(-4)} sent`);
    } catch (e) {
      statuses.push(`wa:${r.phone.slice(-4)} error: ${errText(e, secrets)}`);
    }
  }
  if (env.ALERT_WEBHOOK_URL) {
    try {
      await call({ method: 'POST', url: env.ALERT_WEBHOOK_URL, body: { text, content: text } });
      statuses.push('webhook sent');
    } catch (e) {
      statuses.push('webhook error: ' + errText(e, secrets));
    }
  }
  res.alert_status = statuses.join('; ');
  return res;
}

module.exports = { act, errText, redact, isTransient, parseWhatsApp };
