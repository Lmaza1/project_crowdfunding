// Side effects for one decided item: private-reply DM, public reply, alert.
// `http({method, url, qs, body})` must resolve to parsed JSON or throw.
// Inlined into workflow.json like core.js; keep `module.exports` LAST.

function errText(e) {
  const r = e && (e.response || e.cause);
  const body = r && (r.body || r.data);
  const g = body && (body.error || (typeof body === 'string' ? safeJson(body).error : null));
  if (g) return `graph error ${g.code}${g.error_subcode ? '/' + g.error_subcode : ''}: ${g.message}`;
  return String((e && e.message) || e).slice(0, 300);
}
function safeJson(s) { try { return JSON.parse(s); } catch (_) { return {}; } }

function commentLink(item, permalink) {
  if (item.platform === 'facebook') return `https://www.facebook.com/${item.commentId}`;
  return permalink || `(Instagram media ${item.postId}, comment ${item.commentId})`;
}

async function act(item, ctx) {
  const { http, env } = ctx;
  const v = env.GRAPH_API_VERSION || 'v21.0';
  const graph = `https://graph.facebook.com/${v}`;
  const token = ctx.token;
  const live = item.mode === 'live';
  const res = { dm_status: '', public_status: '', alert_status: '' };

  // 1) Private reply first. The public reply promises a message, so we only
  //    post it once the DM actually went out.
  if (!live) {
    res.dm_status = 'dry_run';
  } else {
    try {
      await http({ method: 'POST', url: `${graph}/${item.pageId}/messages`, qs: { access_token: token },
        body: { recipient: { comment_id: item.commentId }, message: { text: item.dmText } } });
      res.dm_status = 'sent';
    } catch (e) {
      res.dm_status = 'error: ' + errText(e);
    }
  }

  // 2) Public reply (not for complaints).
  if (item.action === 'reply') {
    if (!live) res.public_status = 'dry_run';
    else if (res.dm_status !== 'sent') res.public_status = 'skipped: dm failed';
    else {
      const edge = item.platform === 'instagram' ? 'replies' : 'comments';
      try {
        await http({ method: 'POST', url: `${graph}/${item.commentId}/${edge}`, qs: { access_token: token },
          body: { message: item.publicText } });
        res.public_status = 'sent';
      } catch (e) {
        res.public_status = 'error: ' + errText(e);
      }
    }
  }

  // 3) Human alert: every complaint, and any reply whose DM failed.
  const needsAlert = item.action === 'recovery' || (live && res.dm_status !== 'sent');
  const whatsapp = parseWhatsApp(env.ALERT_WHATSAPP);
  if (needsAlert && (env.ALERT_WEBHOOK_URL || whatsapp.length)) {
    let permalink = null;
    if (item.platform === 'instagram' && item.postId && token && live) {
      try { permalink = (await http({ method: 'GET', url: `${graph}/${item.postId}`, qs: { fields: 'permalink', access_token: token } })).permalink; } catch (_) {}
    }
    const who = item.fromName || (item.fromUsername ? '@' + item.fromUsername : 'usuario');
    const why = item.action === 'recovery' ? 'Comentario negativo' : 'No se pudo enviar el DM';
    const text = `${live ? '' : '[PRUEBA] '}${why} — ${item.brand} (${item.platform})\n` +
      `${who}: "${String(item.text).slice(0, 500)}"\n${commentLink(item, permalink)}\nDM: ${res.dm_status}`;
    const statuses = [];
    // WhatsApp via CallMeBot: one GET per recipient, each with their own apikey.
    for (const r of whatsapp) {
      try {
        await http({ method: 'GET', url: 'https://api.callmebot.com/whatsapp.php', qs: { phone: r.phone, text, apikey: r.apikey } });
        statuses.push(`wa:${r.phone.slice(-4)} sent`);
      } catch (e) {
        statuses.push(`wa:${r.phone.slice(-4)} error: ${errText(e)}`);
      }
    }
    if (env.ALERT_WEBHOOK_URL) {
      try {
        await http({ method: 'POST', url: env.ALERT_WEBHOOK_URL, body: { text, content: text } });
        statuses.push('webhook sent');
      } catch (e) {
        statuses.push('webhook error: ' + errText(e));
      }
    }
    res.alert_status = statuses.join('; ');
  } else if (needsAlert) {
    res.alert_status = 'no alert channel configured';
  }
  return res;
}

// "50212345678:123456, +502 8765-4321:654321" -> [{phone:'50212345678', apikey:'123456'}, ...]
function parseWhatsApp(s) {
  return String(s || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const i = x.lastIndexOf(':');
    return { phone: x.slice(0, i).replace(/\D/g, ''), apikey: x.slice(i + 1).trim() };
  }).filter((r) => r.phone && r.apikey);
}

module.exports = { act, errText, parseWhatsApp };
