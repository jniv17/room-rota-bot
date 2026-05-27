/**
 * SLPRotaSlavebot — Cloudflare Worker
 * Cron: 7am UK time Mon-Fri → sends rota to users registered for that day
 * Webhook: responds to messages with smart date parsing
 * 
 * Fallback: If scheduled send misses, the first webhook call of the day triggers it
 *
 * Environment variables:
 *   TELEGRAM_BOT_TOKEN  — bot token from BotFather
 *   ALLOWED_CHAT_IDS    — comma-separated chat IDs
 *   SHEET_CSV_URL       — Google Sheet CSV export URL
 */

const SHAREPOINT_SITE = "https://nhs.sharepoint.com/sites/msteams_16ddac";
const DOCS_BASE       = "Shared%20Documents/General";
const EM_DASH         = "%E2%80%93";
const SPACE           = "%20";

const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];


// ── UK date/time for a given Date object ─────────────────────────────
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
  const date = `${day}.${mon}.${year}`;
  const hour = parseInt(get("hour"), 10);

  const folder = `${SHAREPOINT_SITE}/${DOCS_BASE}/${year}%20Room%20Rota`;
  const isWeekday = !["SATURDAY","SUNDAY"].includes(DAY);

  const variants = [
    { label: `${DAY} \u2013 ${date}`, url: `${folder}/${DAY}${SPACE}${EM_DASH}${SPACE}${date}.docx` },
    { label: `${DAY} ${date}`,        url: `${folder}/${DAY}${SPACE}${date}.docx` },
    { label: `${DAY} - ${date}`,      url: `${folder}/${DAY}${SPACE}-${SPACE}${date}.docx` },
    { label: `${Day} \u2013 ${date}`, url: `${folder}/${Day}${SPACE}${EM_DASH}${SPACE}${date}.docx` },
  ];

  return { variants, folder, DAY, Day, date, year, hour, isWeekday };
}


// ── Smart date parser ────────────────────────────────────────────────
// Works out which date the user is asking about from their message text
function parseDateFromMessage(text) {
  const lower = text.toLowerCase().trim();
  const now   = new Date();

  // Get current UK date info
  const ukParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
  }).formatToParts(now);
  const todayName = ukParts.find(p => p.type === "weekday")?.value ?? "";
  const todayIdx  = DAY_NAMES.findIndex(d => d.toLowerCase() === todayName.toLowerCase());

  // "tomorrow"
  if (lower.includes("tomorrow")) {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    // Skip to Monday if tomorrow is Saturday or Sunday
    const tIdx = tomorrow.getDay();
    if (tIdx === 6) tomorrow.setDate(tomorrow.getDate() + 2);
    if (tIdx === 0) tomorrow.setDate(tomorrow.getDate() + 1);
    return { date: tomorrow, label: "tomorrow" };
  }

  // "next week" → next Monday
  if (lower.includes("next week")) {
    const nextMon = new Date(now);
    const daysUntilMon = (8 - now.getDay()) % 7 || 7;
    nextMon.setDate(nextMon.getDate() + daysUntilMon);
    return { date: nextMon, label: "next Monday" };
  }

  // Day name e.g. "wednesday", "friday"
  for (let i = 0; i < DAY_NAMES.length; i++) {
    if (lower.includes(DAY_NAMES[i].toLowerCase())) {
      const target = new Date(now);
      let diff = i - todayIdx;
      if (diff <= 0) diff += 7; // always next occurrence
      target.setDate(target.getDate() + diff);
      return { date: target, label: DAY_NAMES[i] };
    }
  }

  // "today" or anything else → today
  return { date: now, label: "today" };
}


// ── Message builder ──────────────────────────────────────────────────
function buildMessage(DAY, date, variants, folder, isWeekday, requestedLabel) {
  const dayLine = requestedLabel && requestedLabel !== "today"
    ? `\u{1F4CB} <b>${DAY} ${date}</b> (${requestedLabel})`
    : `\u{1F4CB} <b>${DAY} ${date}</b>`;

  if (!isWeekday) {
    return `${dayLine}\n\nNo rota \u2014 that\u2019s a weekend.`;
  }

  const lines = [
    dayLine,
    ``,
    `<a href="${folder}">\u{1F4C1} Open rota folder</a>`,
    ``,
    `Try direct links:`,
  ];
  variants.forEach((v, i) => lines.push(`<a href="${v.url}">${i + 1}. ${v.label}</a>`));
  return lines.join("\n");
}


// ── Telegram ─────────────────────────────────────────────────────────
async function sendMessage(token, chatId, text) {
  const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: String(chatId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  const json = await resp.json();
  if (!json.ok) console.error(`Telegram error for ${chatId}:`, JSON.stringify(json));
  return json;
}


// ── Google Sheet: get users working on a given day name ───────────────
async function getUsersWorkingOn(sheetCsvUrl, dayName) {
  try {
    const resp    = await fetch(sheetCsvUrl);
    const text    = await resp.text();
    const lines   = text.trim().split("\n");
    const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
    const nameIdx = headers.findIndex(h => h === "Full Name");
    const daysIdx = headers.findIndex(h => h === "Working Days");
    const chatIdx = headers.findIndex(h => h === "Your Telegram Chat ID");

    console.log(`Sheet headers: ${JSON.stringify(headers)}`);

    return lines.slice(1)
      .map(line => {
        const cols  = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
        const clean = cols.map(c => c.replace(/^"|"$/g, "").trim());
        return {
          name:   clean[nameIdx] ?? "",
          days:   clean[daysIdx] ?? "",
          chatId: clean[chatIdx] ?? "",
        };
      })
      .filter(u => u.chatId && u.days.includes(dayName));
  } catch (err) {
    console.error("Sheet fetch error:", err);
    return [];
  }
}


// ── Get today's date in YYYY-MM-DD format (UK timezone) ───────────────
function getTodayDateString() {
  const now = new Date();
  const ukParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  
  const year = ukParts.find(p => p.type === "year")?.value;
  const month = ukParts.find(p => p.type === "month")?.value;
  const day = ukParts.find(p => p.type === "day")?.value;
  
  return `${year}-${month}-${day}`;
}


// ── Scheduled 7am send (Mon–Fri) ─────────────────────────────────────
async function handleScheduled(env) {
  if (!env.SHEET_CSV_URL) {
    console.log("No SHEET_CSV_URL set — skipping scheduled send.");
    return;
  }

  const { variants, folder, DAY, date, isWeekday } = getUKDateTime();

  if (!isWeekday) {
    console.log(`Weekend (${DAY}) — skipping.`);
    return;
  }

  // Readable day name for Sheet lookup e.g. "Thursday"
  const dayReadable = DAY.charAt(0) + DAY.slice(1).toLowerCase();
  const users       = await getUsersWorkingOn(env.SHEET_CSV_URL, dayReadable);

  console.log(`${DAY} ${date} — ${users.length} user(s) registered for today.`);

  if (!users.length) {
    console.log("Nobody registered for today — nothing to send.");
    return;
  }

  const message = buildMessage(DAY, date, variants, folder, true, null);
  let sentCount = 0;
  for (const u of users) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, u.chatId, message);
    console.log(`  \u2713 ${u.name}`);
    sentCount++;
  }

  // Store that we've sent today's scheduled message
  if (env.ROTA_STATE) {
    try {
      const state = env.ROTA_STATE.get("lastSentDate");
      await state.put("lastSentDate", getTodayDateString());
      console.log("✓ Marked today's scheduled send as complete");
    } catch (err) {
      console.error("Failed to store last sent date:", err);
    }
  }

  return sentCount;
}


// ── Webhook: respond to incoming messages ────────────────────────────
async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response("Bad request", { status: 400 }); }

  const message = body?.message;
  if (!message) return new Response("OK", { status: 200 });

  const chatId  = String(message.chat?.id);
  const token   = env.TELEGRAM_BOT_TOKEN;
  const allowed = (env.ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim());

  // Check ALLOWED_CHAT_IDS first, then fall back to Sheet
  let isAuthorised = allowed.includes(chatId);

  if (!isAuthorised && env.SHEET_CSV_URL) {
    const resp    = await fetch(env.SHEET_CSV_URL);
    const text    = await resp.text();
    isAuthorised = text.includes(chatId);
  }

  if (!isAuthorised) {
    console.log(`Unknown chat_id: ${chatId} — sending signup instructions`);
    await sendMessage(token, chatId,
      `👋 <b>Hi! I'm the SLP Clinic Rota Bot.</b>\n\n` +
      `I send your room rota to your phone automatically every morning.\n\n` +
      `To sign up, follow the simple steps here:\n` +
      `<a href="https://jniv17.github.io/room-rota-bot">👉 Tap to set up notifications</a>\n\n` +
      `It takes about 3 minutes and you only need to do it once.`
    );
    return new Response("OK", { status: 200 });
  }

  // ── FALLBACK: Check if scheduled send has run today ──────────────────
  // If not, and today is a weekday, trigger it now
  const { isWeekday: todayIsWeekday } = getUKDateTime();
  if (todayIsWeekday && env.ROTA_STATE) {
    try {
      const state = env.ROTA_STATE.get("lastSentDate");
      const lastSent = await state.get("lastSentDate");
      const todayStr = getTodayDateString();

      if (lastSent !== todayStr) {
        console.log(`⚠️  Scheduled send appears to have missed. Triggering fallback...`);
        await handleScheduled(env);
      }
    } catch (err) {
      console.error("Error checking last sent date:", err);
      // On error, don't break the user experience — just continue
    }
  }

  // Parse what date they're asking about
  const userText = message.text || "";
  const { date: targetDate, label } = parseDateFromMessage(userText);
  const { variants, folder, DAY, date, isWeekday } = getUKDateTime(targetDate);

  const text = buildMessage(DAY, date, variants, folder, isWeekday, label);
  await sendMessage(token, chatId, text);

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
