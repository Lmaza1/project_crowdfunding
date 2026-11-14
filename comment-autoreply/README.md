# Comment auto-reply: ConstruR3 + Vas con Maz (Facebook + Instagram)

Self-hosted n8n workflow on the Mac Studio. For every new comment on the two Facebook Pages and the two Instagram accounts it:

1. checks the Meta signature, ignores the brand's own comments and anything already handled (one private reply per comment; Meta allows it for 7 days),
2. sorts complaints from everything else (Spanish keyword list in `src/core.js`, `NEGATIVE_PATTERNS`),
3. waits a random 30–90 s,
4. sends the **private-reply DM** first, then the **public reply** (rotating 3 variants per brand). The public reply says "te enviamos por mensaje", so it is only posted once the DM has gone out,
5. for complaints it sends only the service-recovery DM, posts nothing public and alerts Luis/Felix,
6. logs every comment to `n8n-data/logs/autoreply-log.csv`.

> **Nothing goes live until Luis approves the copy.** `copy.json` has `"approved": false`. While it does, even `AUTOREPLY_MODE=live` runs as dry-run: everything is logged, nothing is sent to Meta.

## Files

| File | What it is |
|---|---|
| `copy.json` | All reply text, both brands. **The only file to edit for copy changes.** |
| `src/core.js` | Parsing, filters, brand routing, name handling, copy rendering |
| `src/act.js` | Graph API calls (DM, public reply) and alerts |
| `workflow.json` | **Generated** n8n workflow (import this). Rebuild with `npm run build` after editing anything above |
| `docker-compose.yml`, `.env.example` | n8n + Cloudflare Tunnel |
| `scripts/simulate-comment.sh` | Sends a signed fake comment to the local n8n |
| `test/` | `npm test`: 16 tests, including the generated n8n code run in a simulated n8n runtime |

## Install on the Mac Studio (Claude / ChatGPT does this part)

1. **Docker Desktop** installed and running. Copy this folder to the Mac (e.g. `~/comment-autoreply`), then `cp .env.example .env && chmod 600 .env`.
2. **Public HTTPS URL (Cloudflare named tunnel, free).** Meta needs a stable URL, so don't use a quick `trycloudflare.com` tunnel: its address changes on every restart. You need a domain on Cloudflare DNS (e.g. move construr3.com's DNS there, or a cheap separate domain).
   Cloudflare Zero Trust → Networks → Tunnels → Create tunnel (cloudflared) → copy the token into `CLOUDFLARE_TUNNEL_TOKEN`. Add a public hostname `hooks.<domain>` → service `http://n8n:5678`, **path `webhook/.*`**, so only the webhooks are public and the n8n editor is not. Put the hostname in `PUBLIC_HOSTNAME`.
3. `docker compose up -d`, open http://localhost:5678 on the Mac, create the owner account with a strong password.
4. n8n → Workflows → Import from file → `workflow.json` → **Activate**.
5. Check: `curl "https://hooks.<domain>/webhook/meta-comments?hub.mode=subscribe&hub.verify_token=<META_VERIFY_TOKEN>&hub.challenge=ok"` must print `ok`.
6. Fill in the IDs in `.env` (step B below), `docker compose up -d` again, then run a dry test:
   `scripts/simulate-comment.sh construr3 facebook "Cuánto cuesta una cocina?" "María López"`
   About a minute later there should be a `dry_run` row in `n8n-data/logs/autoreply-log.csv` with the exact text that would have been sent.

Tokens live only in `.env` on the Mac (chmod 600), not in n8n credentials. The brief said "n8n credentials", but n8n can't switch credentials per brand inside one HTTP node, and `.env` keeps them out of chat and git just as well.

## Meta setup (Luis does this part)

A. **App:** developers.facebook.com → Create app → Business type, owned by the business portfolio that owns both Pages. Add the products **Webhooks**, **Messenger** and **Instagram (API setup with Facebook login)**.

B. **Permissions** (Facebook Login flavour, so one Page token covers the Page *and* its linked IG account):
`pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_messaging`, `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`, `business_management`.
> The brief listed `instagram_business_manage_*`. Those belong to the *Instagram Login* API (graph.instagram.com, separate IG tokens) and don't mix with Page tokens. It also left out `pages_messaging`, which Facebook private replies need.

C. **Tokens:** Business Settings → System users → add an admin system user → assign both Pages (full control) → generate a token with the permissions above. Then get each Page's own token: `GET /me/accounts` with that system-user token. Use those as `CONSTRUR3_PAGE_TOKEN` / `VASCONMAZ_PAGE_TOKEN`. System-user tokens don't expire every 60 days the way a personal login does. Page IDs come from the same call. IG IDs come from `GET /{page-id}?fields=instagram_business_account`.

D. **Webhooks:** in the app → Webhooks: object **Page** → callback `https://hooks.<domain>/webhook/meta-comments`, verify token = `META_VERIFY_TOKEN`, subscribe field `feed`. Object **Instagram** → same URL and token, field `comments`. Then attach the app to each Page: `POST /{page-id}/subscribed_apps?subscribed_fields=feed&access_token=<page token>`.

E. **Instagram setting**, on each IG account in the app: Settings → Messages and story replies → Message controls → Connected tools → **Allow access to messages** on. Without it, IG DMs fail.

F. **Business Verification + App Review (Advanced Access)** for the permissions above. Record the screencasts with the workflow in dry-run plus one live test on a test comment. This is the slow step.
> Worth checking first: Meta sometimes lets an app read and reply on assets owned by the app's own business with *Standard* Access in Live mode. Before starting review, switch the app to Live, comment from a personal account, and see whether the webhook arrives. If it does, review may be unnecessary. If not, go through review as planned.

## Go-live checklist (Muse verifies)

1. Luis approves the copy → set `"approved": true`, `approved_by`, `approved_on` in `copy.json` → `npm run build` → re-import `workflow.json` (replace the old one) → activate.
2. `.env`: `AUTOREPLY_MODE=live`, `TEST_ONLY_USER_IDS=<Felix's or a test account's ID>` (the ID shows up in the log's `from_id` after a dry-run comment). `docker compose up -d`.
3. Test comment on each of the four accounts → check the public reply, the DM and the `live` log row. Also test one complaint comment: DM only, plus an alert.
4. Clear `TEST_ONLY_USER_IDS`, then `docker compose up -d`. Everyone now gets replies.
5. Kill switch at any time: `AUTOREPLY_MODE=off` (or `dry_run`) + `docker compose up -d`, or deactivate the workflow in n8n.

## Behaviour notes

- **Names:** Facebook gives the commenter's name, so `{nombre}` becomes the first name ("María José López" → "María"). Instagram only gives a @username, and greeting people by handle reads like a bot, so on IG the name is dropped cleanly ("¡Gracias, {nombre}!" → "¡Gracias!"). Tests cover every template both ways.
- `{saludo}` is available (Buenos días / Buenas tardes / Buenas noches, Guatemala time) but not used yet: see the copy notes below.
- **Loops:** the brand's own replies come back as comment webhooks. They are recognised by account ID and skipped.
- **Failed DM** (user blocks messages, comment older than 7 days, etc.): no public reply, because it would promise a message that never arrives. Luis/Felix get an alert to answer by hand.
- **Dedupe** is kept in n8n's workflow memory for 8 days. Meta retries only when we don't answer 200, and the webhook answers immediately, so duplicates are rare in practice.

## Copy notes for Luis's review (copy in `copy.json` is unchanged from the brief)

1. **Vas con Maz DM opens with "Buenas tardes" around the clock.** A comment at 9 a.m. gets "Buenas tardes". Suggestion: replace it with `{saludo}`, which adjusts to the time of day.
2. **ConstruR3 public #1 promises "ejemplos de proyectos parecidos a lo que buscas"**, but the DM sends the general portfolio. Suggestion: "…Te enviamos por mensaje ejemplos de nuestros proyectos."
3. **ConstruR3 public #2 starts "¡Qué bueno que te gustó!"**, and with "any comment" it will also land on questions ("¿precio?") and tags ("@amigo mira"). Suggestion: "¡Gracias por escribirnos, {nombre}!"
4. **Mixed "we/I" in both DMs:** "Te escribimos… Te comparto… Cuéntame… te ayudamos" (VcM: "Le escribimos… Le comparto"). Pick one voice. Plural ("te compartimos", "cuéntanos") matches the public replies.
5. **Portfolio links not verified.** I couldn't reach construr3.com or vasconmaz.com from here. Open both `/portafolio/` links before approving. A dead link in the very first DM costs the trust the DM is meant to build.
6. **Where alerts go** (Slack, Discord, WhatsApp via a bridge, email?) isn't decided. The workflow posts to `ALERT_WEBHOOK_URL`, so anything that accepts a webhook works.
