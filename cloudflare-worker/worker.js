/**
 * SLPRotaSlavebot — Cloudflare Worker
 * Cron: fires at 6am and 7am UTC Mon-Fri (covers BST and GMT); handleScheduled
 *       only sends on the trigger that lands on 7am UK time.
 * Webhook: responds to messages with smart date parsing
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN  — bot token from BotFather
 *   ALLOWED_CHAT_IDS    — comma-separated chat IDs (fallback + admin)
 *   SHEET_CSV_URL       — Google Sheet published CSV URL
 */

const SHAREPOINT_SITE = "https://nhs.sharepoint.com/sites/msteams_16ddac";
const DOCS_BASE       = "Shared%20Documents/General";
const EM_DASH         = "%E2%80%93";
const SPACE           = "%20";
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];


// ── UK date/time ─────────────────────────────────────────────────────
function getUKDateTime(forDate = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "long", hour: "2-digit", hour12: false,
  }).formatToParts(forDate);

  const get  = (type) => parts.find(p => p.type === type)?.value ?? "";
  const DAY  = get("weekday").toUpperCase();
  const Day  = DAY.charAt(0) + DAY.slice(1).toLowerCase();
  const day  = get("day");
  const mon  = get("month");
  const year = get("year");
  const hour = parseInt(get("hour"), 10);
  const date = `${day}.${mon}.${year}`;
  const folder = `${SHAREPOINT_SITE}/${DOCS_BASE}/${year}%20Room%20Rota`;
  const isWeekday = !["SATURDAY","SUNDAY"].includes(DAY);

  const variants = [
    { label: `${DAY} \u2013 ${date}`, url: `${folder}/${DAY}${SPACE}${EM_DASH}${SPACE}${date}.docx` },
  ];

  return { variants, folder, DAY, Day, date, year, hour, isWeekday };
}


// ── Smart date parser ─────────────────────────────────────────────────
function parseDateFromMessage(text) {
  const lower = text.toLowerCase().trim();
  const now   = new Date();
  const ukParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", weekday: "long",
  }).formatToParts(now);
  const todayName = ukParts.find(p => p.type === "weekday")?.value ?? "";
  const todayIdx  = DAY_NAMES.findIndex(d => d.toLowerCase() === todayName.toLowerCase());

  if (lower.includes("tomorrow")) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tIdx = tomorrow.getDay();
    if (tIdx === 6) tomorrow.setDate(tomorrow.getDate() + 2);
    if (tIdx === 0) tomorrow.setDate(tomorrow.getDate() + 1);
    return { date: tomorrow, label: "tomorrow" };
  }
  if (lower.includes("next week")) {
    const nextMon = new Date(now);
    const daysUntilMon = (8 - now.getDay()) % 7 || 7;
    nextMon.setDate(nextMon.getDate() + daysUntilMon);
    return { date: nextMon, label: "next Monday" };
  }
  for (let i = 0; i < DAY_NAMES.length; i++) {
    if (lower.includes(DAY_NAMES[i].toLowerCase())) {
      const target = new Date(now);
      let diff = i - todayIdx;
      if (diff <= 0) diff += 7;
      target.setDate(target.getDate() + diff);
      return { date: target, label: DAY_NAMES[i] };
    }
  }
  return { date: now, label: "today" };
}


// ── Message builder ───────────────────────────────────────────────────
function buildMessage(DAY, date, variants, folder, isWeekday, requestedLabel) {
  const dayLine = requestedLabel && requestedLabel !== "today"
    ? `\u{1F4CB} <b>${DAY} ${date}</b> (${requestedLabel})`
    : `\u{1F4CB} <b>${DAY} ${date}</b>`;

  if (!isWeekday) return `${dayLine}\n\nNo rota \u2014 that\u2019s a weekend.`;

  const lines = [
    dayLine, ``,
    `<a href="${folder}">\u{1F4C1} Open rota folder</a>`,
    `<a href="${variants[0].url}">\u{1F4C4} ${variants[0].label}</a>`,
  ];
  return lines.join("\n");
}


// ── Telegram ──────────────────────────────────────────────────────────
async function sendMessage(token, chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(chatId), text,
      parse_mode: "HTML", disable_web_page_preview: true,
    }),
  });
  const json = await resp.json();
  if (!json.ok) console.error(`Telegram error for ${chatId}:`, JSON.stringify(json));
  return json;
}


// ── Sheet reader with HTML detection ─────────────────────────────────
async function getUsersWorkingOn(sheetCsvUrl, dayName) {
  try {
    const resp = await fetch(sheetCsvUrl);
    const text = await resp.text();

    // Detect if Google returned HTML instead of CSV
    if (text.trim().startsWith("<") || text.includes("<!DOCTYPE")) {
      console.error("Sheet returned HTML — URL is wrong or sheet is not published correctly.");
      return null; // null = signal to use fallback
    }

    const lines   = text.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
    const nameIdx = headers.findIndex(h => h === "Full Name");
    const daysIdx = headers.findIndex(h => h === "Working Days");
    const chatIdx = headers.findIndex(h => h === "Your Telegram Chat ID");

    console.log(`Sheet headers: ${JSON.stringify(headers)}`);
    console.log(`${lines.length - 1} user(s) in sheet`);

    return lines.slice(1)
      .map(line => {
        const cols  = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
        const clean = cols.map(c => c.replace(/^"|"$/g, "").trim());
        return { name: clean[nameIdx] ?? "", days: clean[daysIdx] ?? "", chatId: clean[chatIdx] ?? "" };
      })
      .filter(u => u.chatId && u.days.includes(dayName));
  } catch (err) {
    console.error("Sheet fetch error:", err.message);
    return null; // null = signal to use fallback
  }
}


// ── Scheduled 7am send ────────────────────────────────────────────────
async function handleScheduled(env) {
  const { variants, folder, DAY, date, hour, isWeekday } = getUKDateTime();

  // wrangler.toml fires this at both 6am and 7am UTC to cover GMT/BST —
  // only the trigger that actually lands on 7am UK time should send.
  if (hour !== 7) { console.log(`UK hour is ${hour}, not 7am. Skipping.`); return; }

  if (!isWeekday) { console.log(`Weekend (${DAY}) — skipping.`); return; }

  const token   = env.TELEGRAM_BOT_TOKEN;
  const message = buildMessage(DAY, date, variants, folder, true, null);
  const dayReadable = DAY.charAt(0) + DAY.slice(1).toLowerCase();

  console.log(`Scheduled send: ${DAY} ${date}`);

  // Try Sheet first
  let sent = false;
  if (env.SHEET_CSV_URL) {
    const users = await getUsersWorkingOn(env.SHEET_CSV_URL, dayReadable);

    if (users === null) {
      // Sheet failed — log clearly and fall through to fallback
      console.error("Sheet read failed. Falling back to ALLOWED_CHAT_IDS.");
    } else if (users.length === 0) {
      console.log(`Nobody in Sheet registered for ${dayReadable}. Falling back to ALLOWED_CHAT_IDS.`);
    } else {
      console.log(`${users.length} user(s) registered for ${dayReadable}:`);
      for (const u of users) {
        await sendMessage(token, u.chatId, message);
        console.log(`  \u2713 ${u.name} (${u.chatId})`);
      }
      sent = true;
    }
  }

  // Fallback: always send to ALLOWED_CHAT_IDS if Sheet didn't work
  if (!sent) {
    const ids = (env.ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (ids.length > 0) {
      console.log(`Fallback: sending to ${ids.length} ALLOWED_CHAT_IDS`);
      for (const id of ids) {
        await sendMessage(token, id, message);
        console.log(`  \u2713 fallback sent to ${id}`);
      }
    } else {
      console.error("No ALLOWED_CHAT_IDS set either. Nothing sent.");
    }
  }
}


// ── Webhook ───────────────────────────────────────────────────────────
async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response("Bad request", { status: 400 }); }

  const message = body?.message;
  if (!message) return new Response("OK", { status: 200 });

  const chatId  = String(message.chat?.id);
  const token   = env.TELEGRAM_BOT_TOKEN;
  const allowed = (env.ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim());

  // Check ALLOWED_CHAT_IDS first, then Sheet
  let isAuthorised = allowed.includes(chatId);

  if (!isAuthorised && env.SHEET_CSV_URL) {
    try {
      const resp = await fetch(env.SHEET_CSV_URL);
      const text = await resp.text();
      if (!text.trim().startsWith("<")) {
        isAuthorised = text.includes(chatId);
      }
    } catch (err) {
      console.error("Sheet auth check failed:", err.message);
    }
  }

  if (!isAuthorised) {
    const prefillUrl = `https://docs.google.com/forms/d/e/1FAIpQLScxwjgcpv_Wu4lZdYbvSfs-pB4TmUJ5ha6n5403b2Je10Xdug/viewform?usp=pp_url&entry.418364204=${chatId}`;
    await sendMessage(token, chatId,
      `\u{1F44B} <b>Hi! Welcome to SLP Clinic Rota Notifications.</b>\n\n` +
      `I send your room rota to your phone automatically at 7am on your clinic days.\n\n` +
      `<b>To sign up, tap the link below.</b> Your ID number is already filled in for you \u2014 you just need to add your name and working days:\n\n` +
      `<a href="${prefillUrl}">\u{1F4DD} Complete your sign-up (1 minute)</a>\n\n` +
      `Set up by Dr Nivern for clinic staff only.`
    );
    return new Response("OK", { status: 200 });
  }

  const userText = message.text || "";
  const { date: targetDate, label } = parseDateFromMessage(userText);
  const { variants, folder, DAY, date, isWeekday } = getUKDateTime(targetDate);
  await sendMessage(token, chatId, buildMessage(DAY, date, variants, folder, isWeekday, label));
  return new Response("OK", { status: 200 });
}


// ── Entry points ──────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK", { status: 200 });
    return handleWebhook(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
