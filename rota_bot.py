"""
Room Rota Telegram Notifier — Multi-user, dual-link version
Sends three links: space format, dash format, and folder fallback.
Logs filename pattern for tracking naming inconsistencies.
"""

import os, sys, csv, io, requests
from datetime import datetime
from zoneinfo import ZoneInfo

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID   = os.environ.get("TELEGRAM_CHAT_ID")
SHEET_CSV_URL      = os.environ.get("SHEET_CSV_URL")

SHAREPOINT_SITE = "https://nhs.sharepoint.com/sites/msteams_16ddac"
DOCS_BASE       = "Shared%20Documents/General"

COL_NAME    = "Full Name"
COL_DAYS    = "Working Days"
COL_CHAT_ID = "Your Telegram Chat ID"


def build_rota_urls(dt):
    year      = dt.year
    day_name  = dt.strftime("%A").upper()
    date_str  = dt.strftime("%d.%m.%Y")
    folder    = f"{year}%20Room%20Rota"
    folder_url = f"{SHAREPOINT_SITE}/{DOCS_BASE}/{folder}"

    # Track both known naming patterns
    url_space = f"{folder_url}/{day_name}%20{date_str}.docx"
    url_dash  = f"{folder_url}/{day_name}%20-%20{date_str}.docx"

    print(f"  Day / Date : {day_name} {date_str}")
    print(f"  Folder     : {year} Room Rota")
    print(f"  Pattern A  : {day_name} {date_str}.docx")
    print(f"  Pattern B  : {day_name} - {date_str}.docx")
    print(f"  Folder URL : {folder_url}")

    return url_space, url_dash, folder_url, day_name, date_str


def build_message(day_name, date_str, url_space, url_dash, folder_url):
    return (
        f"📋 <b>{day_name} {date_str}</b>\n\n"
        f'<a href="{url_space}">Open Room Rota</a>  ·  <a href="{url_dash}">Alt link</a>\n'
        f'<a href="{folder_url}">📁 Browse rota folder</a>'
    )


def get_users_from_sheet():
    print("Fetching users from Google Sheet...")
    resp = requests.get(SHEET_CSV_URL, timeout=30)
    resp.raise_for_status()
    reader = csv.DictReader(io.StringIO(resp.text))
    # Strip whitespace from all column headers
    reader.fieldnames = [f.strip() for f in reader.fieldnames]
    users = list(reader)
    print(f"  {len(users)} registered user(s).")
    print(f"  Columns found: {reader.fieldnames}")
    return users


def users_working_today(users, today_name):
    return [
        u for u in users
        if today_name in [d.strip() for d in u.get(COL_DAYS, "").split(",")]
    ]


def send_telegram(chat_id, name, text):
    resp = requests.post(
        f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
        json={"chat_id": str(chat_id).strip(), "text": text,
              "parse_mode": "HTML", "disable_web_page_preview": True},
        timeout=30,
    )
    ok = resp.status_code == 200 and resp.json().get("ok")
    print(f"  {'✓' if ok else '✗'} {name}")
    if not ok:
        print(f"    Error: {resp.text}")


def main():
    if not TELEGRAM_BOT_TOKEN:
        print("ERROR: TELEGRAM_BOT_TOKEN not set.")
        sys.exit(1)

    uk_now = datetime.now(ZoneInfo("Europe/London"))
    print(f"UK time : {uk_now.isoformat()}")
    print(f"Day     : {uk_now.strftime('%A')} | Hour: {uk_now.hour}")

    force = os.environ.get("FORCE_SEND", "false").lower() == "true"

    if force:
        print("FORCE_SEND=true — bypassing gates.")
    else:
        if uk_now.hour != 7:
            print(f"Hour is {uk_now.hour}, not 7am. Skipping.")
            return
        if uk_now.weekday() not in (2, 3, 4):
            print(f"Not a clinic day. Skipping.")
            return

    print("-" * 50)
    url_space, url_dash, folder_url, day_name, date_str = build_rota_urls(uk_now)
    today_name = uk_now.strftime("%A")
    message    = build_message(day_name, date_str, url_space, url_dash, folder_url)
    print("-" * 50)

    if SHEET_CSV_URL:
        users   = get_users_from_sheet()
        working = users_working_today(users, today_name)
        print(f"{len(working)} user(s) working today:")
        if not working:
            print("Nobody registered for today.")
            return
        for u in working:
            name    = u.get(COL_NAME, "Unknown").strip()
            chat_id = u.get(COL_CHAT_ID, "").strip()
            if not chat_id:
                print(f"  Skipping {name} — no chat ID.")
                continue
            send_telegram(chat_id, name, message)
    else:
        if not TELEGRAM_CHAT_ID:
            print("ERROR: No SHEET_CSV_URL or TELEGRAM_CHAT_ID set.")
            sys.exit(1)
        print("Single-user mode.")
        send_telegram(TELEGRAM_CHAT_ID, "Josh", message)

    print("-" * 50)
    print("Done.")


if __name__ == "__main__":
    main()
