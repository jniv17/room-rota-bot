# Room Rota Bot 📋

Sends a Telegram message at 7am UK time every **Wednesday, Thursday, Friday** with a clickable link to the day's room rota on SharePoint.

## How it works

1. GitHub Actions fires at 6am + 7am UTC (covers BST/GMT year-round)
2. Script checks if it's actually 7am UK time (skips the wrong one)
3. Constructs the SharePoint URL from today's date — e.g. `WEDNESDAY 14.05.2026.docx`
4. Sends you a Telegram message with the link
5. You tap it, SharePoint opens in your browser/Teams (you're already logged in)

**Security**: The script never accesses SharePoint. Zero API calls, zero credentials, zero file access. It just builds a URL string from the date and posts it to Telegram.

## Setup (one-time, ~5 minutes)

### 1. Create a Telegram bot
- Open Telegram → search `@BotFather` → `/newbot`
- Name it, e.g. `Josh Rota Bot`
- Save the **token** BotFather gives you

### 2. Get your Telegram chat ID
- Message your new bot anything (e.g. "hello")
- Open in browser: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
- Find `"chat":{"id":123456789}` — that number is your chat ID

### 3. Create GitHub repo
- Go to github.com → New repository → name it `room-rota-bot` → **Private**
- Push these files to it

### 4. Add secrets
- In your repo → Settings → Secrets and variables → Actions
- Add **TELEGRAM_BOT_TOKEN** = your bot token
- Add **TELEGRAM_CHAT_ID** = your chat ID

### 5. Test it
- Go to Actions tab → "Room Rota Notification" → "Run workflow"
- Check your Telegram — you should get a message

## Troubleshooting

If a link 404s when you tap it, check the GitHub Actions log (Actions tab → latest run → click the job). The log shows the exact URL, day name, and filename it constructed. Common causes:

- Supervisor named the file differently (e.g. `Wed` instead of `WEDNESDAY`)
- Date format changed (e.g. `13-05-2026` instead of `13.05.2026`)
- Folder name changed

Logs are kept for 90 days. If patterns change, update the `build_rota_url()` function.

## File naming assumption

```
{YEAR} Room Rota/{DAYNAME} {DD}.{MM}.{YYYY}.docx
e.g. 2026 Room Rota/WEDNESDAY 13.05.2026.docx
```

If this convention changes, edit the format strings in `rota_bot.py`.
