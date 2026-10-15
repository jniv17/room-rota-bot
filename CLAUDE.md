# Room Rota SLP

Telegram notification service that sends SLP clinic staff a link to that day's room rota at 7am UK time on their working days (Mon to Fri). Owner: Dr Josh Nivern (GP). Josh is non-technical but hands-on: explain changes in plain English, keep the bot simple, never add infrastructure that is not needed.

State below is accurate as of 15 Oct 2026 (two-digit-year filename fix).

## Hard rules

- No patient-identifiable data anywhere: code, logs, messages, commits. The bot only ever handles staff names, working days and Telegram chat IDs.
- This repo is PUBLIC. Never commit colleagues' names, chat IDs, the bot token or any secret. Secrets live in Cloudflare only.
- Do not rename the GitHub repo. The onboarding page URL (`jniv17.github.io/room-rota-bot`) and the Cloudflare Git build link both depend on the name `room-rota-bot`.
- Keep `wrangler.toml` crons in named-day form (`MON-FRI`). Numeric `1-5` is read by Cloudflare as Sunday to Thursday and silently skipped every Friday for weeks. `wrangler.toml` overwrites the dashboard trigger on every deploy, so the file is the source of truth.
- Do not reintroduce rejected ideas: KV state store for missed sends (the `ALLOWED_CHAT_IDS` fallback already covers it), SMS/Twilio (cost kills the model), WhatsApp (Meta API restrictions).

## Architecture

```
Google Form  ->  Google Sheet (Form_Responses tab, published to web as CSV)
                         |
Cloudflare Worker `gp-rota-bot`  (cloudflare-worker/worker.js)  <- PRIMARY
   - scheduled(): cron 06:00 + 07:00 UTC Mon-Fri, sends only when UK hour == 7 (covers BST and GMT)
   - fetch(): Telegram webhook, replies on demand ("today", "tomorrow", day names, "next week")
                         |
Telegram bot (display name "SLP Rota Notification", @SLPRotaSlavebot)
                         |
NHS SharePoint rota .docx (opens via user's NHS Microsoft login)
```

Backup: `rota_bot.py` + `.github/workflows/rota-notify.yml` (GitHub Actions). Schedule is commented out, `workflow_dispatch` only, so it never double-sends.

## Files

| Path | Purpose |
|---|---|
| `cloudflare-worker/worker.js` | All live bot logic |
| `wrangler.toml` | Worker name, entry point, cron triggers |
| `docs/index.html` | Colleague onboarding page (GitHub Pages) |
| `rota_bot.py` | Python backup sender |
| `.github/workflows/rota-notify.yml` | Manual-run backup workflow |

## Deployment (important)

There is NO GitHub Action that deploys the Worker. Deployment is Cloudflare Workers Builds (Git integration): Cloudflare dashboard -> Workers & Pages -> `gp-rota-bot` -> Settings -> Build. Connected to `jniv17/room-rota-bot`, production branch `main`, deploy command `npx wrangler deploy`, root `/`.

So: push to `main` -> Cloudflare builds -> live. If live behaviour does not match `main`, the build failed or did not trigger. Check Deployments / Builds in the dashboard (or the commit's check status on GitHub) before touching code.

This session has no Cloudflare credentials. Claude cannot deploy directly; it can only push to `main` (requires the repo attached with push access) and let Workers Builds deploy.

Editing a Cloudflare secret does NOT redeploy. Trigger a deploy after changing one.

## Config

Runtime secrets (Settings -> Variables and Secrets, the runtime ones, not Build vars):
- `TELEGRAM_BOT_TOKEN`
- `ALLOWED_CHAT_IDS` (admin + fallback; currently Josh only)
- `SHEET_CSV_URL` must be the **Publish to web** CSV URL (`/spreadsheets/d/e/.../pub?gid=1214284349&single=true&output=csv`). The `/edit` or `/export` URL returns a Google login HTML page to Cloudflare's servers and the bot finds 0 users.

Non-secret identifiers:
- Worker URL: `https://gp-rota-bot.joshuanivern.workers.dev`
- Onboarding page: `https://jniv17.github.io/room-rota-bot`
- Form: `https://forms.gle/h9wkMq99sDLe5h1H7`
- Form pre-fill: `https://docs.google.com/forms/d/e/1FAIpQLScxwjgcpv_Wu4lZdYbvSfs-pB4TmUJ5ha6n5403b2Je10Xdug/viewform?usp=pp_url&entry.418364204=<chatId>`
- Sheet columns (headers may carry stray whitespace, always trim): `Timestamp`, `Full Name`, `Working Days`, `Your Telegram Chat ID`

SharePoint:
- Folder: `https://nhs.sharepoint.com/sites/msteams_16ddac/Shared%20Documents/General/{YEAR}%20Room%20Rota`
- Current filename convention (since Oct 2026): `{DAY} {DD}.{MM}.{YY}.docx`, day in capitals, single space, no dash, TWO-digit year. e.g. `THURSDAY 15.10.26.docx`. Folder name keeps the four-digit year (`2026 Room Rota`).
- History: the supervisor changes the convention without notice. Earlier files used en dash, hyphen, space, and four-digit years (`TUESDAY 13.10.2026.docx`). The bot can't check which file exists (SharePoint needs NHS login), so it builds one direct link plus the folder link as a fallback. If the direct link 404s, ask Josh for a screenshot of the folder and match it.
- NHS sign-in cannot be bypassed. Users who have not completed NHS Microsoft sign-in on their phone will see a login page.

## Current behaviour (worker.js)

- Message = date header + two links: "Open rota folder" and the direct `.docx` link.
- Scheduled send: reads Sheet; if Sheet returns HTML, errors, or has nobody for today, falls back to `ALLOWED_CHAT_IDS` so Josh always gets a message.
- Webhook: authorised if chat ID is in `ALLOWED_CHAT_IDS` or appears in the Sheet. Unknown users get a pre-filled sign-up form link with their chat ID already inserted.

## Testing

- On-demand: message the bot "today" / "tomorrow" and tap the link.
- Scheduled path without waiting for 7am: temporarily add to the top of `fetch()`:
  ```js
  const url = new URL(request.url);
  if (url.searchParams.get("test_scheduled") === "true") {
    await handleScheduled(env);
    return new Response("Scheduled test fired", { status: 200 });
  }
  ```
  Note `handleScheduled` skips unless UK hour is 7, so bypass the hour gate for the test too. Visit `https://gp-rota-bot.joshuanivern.workers.dev/?test_scheduled=true`. Remove both changes afterwards.
- Cron history: Cloudflare -> Settings -> Trigger Events -> View events.

## Known loose ends

- `docs/index.html` still links `t.me/SLPRotaSlavebot` and still walks users through @userinfobot to find their ID. The pre-filled form link from the bot has made that step redundant; the page could be simplified to "install Telegram, message the bot, tap the link it sends".
- @username `SLPRotaSlavebot` is permanent (Telegram has no rename). Only fix is migrating to a new bot: `/newbot`, swap `TELEGRAM_BOT_TOKEN` in Cloudflare, `setWebhook` to the Worker URL, update `t.me` links, message existing users from the old bot. Not worth it until rolling out beyond SLP.
- `rota_bot.py` still uses old secret names (`TELEGRAM_CHAT_ID`) and Node 20 actions; low priority because it is manual-only.

## Monetisation (designed, not built)

Lean: per-clinic subscription (GBP 15-30/month) with manual billing to start. Stripe Payment Link; add `Email` and `Paid Until` columns; 4-week trial from `Timestamp`; worker sends a payment link instead of the rota when `Paid Until` is blank or expired; Josh updates `Paid Until` by hand so re-submitting the form cannot reset the trial. Undecided: per-person vs per-clinic, manual vs automated.

## Working style

- Lead with the verdict, then reasoning. Concise. Push back if a request will not work.
- Never use em dashes in user-facing text or bot messages written going forward; use a comma.
- Ask before building anything beyond a small fix. Prefer the smallest change that works.
- After any change, tell Josh exactly what he needs to do (if anything) to see it live, and how to confirm it worked.
