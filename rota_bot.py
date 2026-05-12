"""
Room Rota Telegram Notifier
Constructs a SharePoint URL for today's room rota and sends it via Telegram.
No SharePoint API access — just URL construction + Telegram message.
"""

import os
import sys
import json
import requests
from datetime import datetime
from zoneinfo import ZoneInfo

# ── Config from environment ──────────────────────────────────────────
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")

# SharePoint constants
SHAREPOINT_SITE = "https://nhs.sharepoint.com/sites/msteams_16ddac"
DOCS_BASE = "Shared%20Documents/General"

# ── URL builder ──────────────────────────────────────────────────────
def build_rota_url(dt):
    """
    Builds the SharePoint direct path URL for a given date.
    Pattern: .../General/{YEAR} Room Rota/{DAYNAME} {DD}.{MM}.{YYYY}.docx
    """
    year = dt.year
    day_name = dt.strftime("%A").upper()       # e.g. WEDNESDAY
    date_str = dt.strftime("%d.%m.%Y")         # e.g. 13.05.2026
    
    folder = f"{year}%20Room%20Rota"
    filename = f"{day_name}%20{date_str}.docx"
    
    url = f"{SHAREPOINT_SITE}/{DOCS_BASE}/{folder}/{filename}"
    return url, day_name, date_str


# ── Telegram sender ──────────────────────────────────────────────────
def send_telegram(day_name, date_str, url):
    """Sends a clean clickable message via Telegram Bot API."""
    text = (
        f"📋 <b>{day_name} {date_str}</b>\n"
        f"\n"
        f"<a href=\"{url}\">Open Room Rota</a>"
    )
    
    resp = requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
        json={
            "chat_id": TELEGRAM_CHAT_ID,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


# ── Main ─────────────────────────────────────────────────────────────
def main():
    # Validate env vars
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("ERROR: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set.")
        sys.exit(1)

    # Get current UK time (handles BST/GMT automatically)
    uk_now = datetime.now(ZoneInfo("Europe/London"))
    print(f"UK time: {uk_now.isoformat()}")
    print(f"Day: {uk_now.strftime('%A')} | Hour: {uk_now.hour}")

    # Manual test runs bypass time/day gates
    force = os.environ.get("FORCE_SEND", "false").lower() == "true"
    
    if force:
        print("FORCE_SEND=true — bypassing time/day gates (manual test)")
    else:
        # Gate: only run at 7am UK (dual cron at 6+7 UTC covers DST)
        if uk_now.hour != 7:
            print(f"Hour is {uk_now.hour}, not 7. Skipping (DST guard).")
            return

        # Gate: only clinic days (Wed=2, Thu=3, Fri=4)
        if uk_now.weekday() not in (2, 3, 4):
            print(f"Today is {uk_now.strftime('%A')}, not a clinic day. Skipping.")
            return

    # Build URL and send
    url, day_name, date_str = build_rota_url(uk_now)

    # Log everything for troubleshooting naming issues
    print(f"──────────────────────────────")
    print(f"Constructed URL: {url}")
    print(f"Day name: {day_name}")
    print(f"Date string: {date_str}")
    print(f"Year folder: {uk_now.year} Room Rota")
    print(f"Expected filename: {day_name} {date_str}.docx")
    print(f"──────────────────────────────")

    result = send_telegram(day_name, date_str, url)
    
    if result.get("ok"):
        print(f"Sent successfully. Message ID: {result['result']['message_id']}")
    else:
        print(f"Telegram error: {json.dumps(result, indent=2)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
