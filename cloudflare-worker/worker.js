/**
 * SLPRotaSlavebot — Cloudflare Worker
 * Cron: 7am UK time Wed/Thu/Fri → sends rota to all registered users
 * Webhook: responds instantly when you message the bot
 *
 * Environment variables (Cloudflare Worker → Settings → Variables):
 *   TELEGRAM_BOT_TOKEN  — bot token from BotFather
 *   ALLOWED_CHAT_IDS    — comma-separated chat IDs e.g. "123456,789012"
 *   SHEET_CSV_URL       — Google Sheet CSV export URL (optional, multi-user)
 */

const SHAREPOINT_SITE = "https://nhs.sharepoint.com/sites/msteams_16ddac";
const DOCS_BASE       = "Shared%20Documents/General";

// URL-encoded characters for filename separators
const EM_DASH   = "%E2%80%93";  // – (what the rota files actually use)
const HYPHEN    = "-";
const SPACE     = "%20";


// ── UK date/time + URL builder ───────────────────────────────────────
function getUKDateTime() {
  const now   = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "long", hour: "2-digit", hour12: false,
  }).formatToParts(now);

  const get  = (type) => parts.find(p => p.type === type)?.value ?? "";
  const DAY  = get("weekday").toUpperCase();
  const Day  = DAY.charAt(0) + DAY.slice(1).toLowerCase();
  const day  = get("day");
  const mon  = get("month");
  const year = get("year");
  const date = `${day}.${mon}.${year}`;

  const folder = `${SHAREPOINT_SITE}/${DOCS_BASE}/${year}%20Room%20Rota`;
  const isClinicDay = ["WEDNESDAY","THURSDAY","FRIDAY"].includes(DAY);

  // Variants in order of likelihood based on observed files
  // THURSDAY – 14.05.2026.docx  (em dash — most common)
  // WEDNESDAY 13.05.2026.docx   (space, no separator)
  // THURSDAY - 14.05.2026.docx  (hyphen)
  const variants = [
    { label: `${DAY} \u2013 ${date}`, url: `${folder}/${DAY}${SPACE}${EM_DASH}${SPACE}${date}.docx` },
    { label: `${DAY} ${date}`,        url: `${folder}/${DAY}${SPACE}${date}.docx` },
    { label: `${DAY} - ${date}`,      url: `${folder}/${DAY}${SPACE}${HYPHEN}${SPACE}${date}.docx` },
    { label: `${Day} \u2013 ${date}`, url: `${folder}/${Day}${SPACE}${EM_DASH}${SPACE}${date}.docx` },
  ];

  return { variants, folder, DAY, date, year, isClinicDay };
}


// ── Message builder ──────────────────────────────────────────────────
function buildMessage(DAY, date, variants, folder, isClinicDay) {
  if (!isClinicDay) {
    return `\u{1F4CB} <b>${DAY} ${date}</b>\n\nNo clinic today \u2014 next clinic days are Wednesday, Thursday, Friday.`;
  }
  const lines = [
    `\u{1F4CB} <b>${DAY} ${date}</b>`,
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


// ── Google Sheet users ────────────────────────────────────────────────
async function getUsersWorkingToday(sheetCsvUrl, todayName) {
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
        return { name: clean[nameIdx] ?? "", days: clean[daysIdx] ?? "", chatId: clean[chatIdx] ?? "" };
      })
      .filter(u => u.chatId && u.days.includes(todayName));
  } catch (err) {
    console.error("Sheet fetch error:", err);
    return [];
  }
}


// ── Scheduled 7am send ────────────────────────────────────────────────
async function handleScheduled(env) {
  const { variants, folder, DAY, date, isClinicDay } = getUKDateTime();
  if (!isClinicDay) { console.log(`Not a clinic day (${DAY})`); return; }

  const token   = env.TELEGRAM_BOT_TOKEN;
  const message = buildMessage(DAY, date, variants, folder, true);
  console.log(`Sending 7am rota: ${DAY} ${date}`);

  if (env.SHEET_CSV_URL) {
    const todayReadable = DAY.charAt(0) + DAY.slice(1).toLowerCase();
    const users = await getUsersWorkingToday(env.SHEET_CSV_URL, todayReadable);
    for (const u of users) {
      await sendMessage(token, u.chatId, message);
      console.log(`  sent to ${u.name}`);
    }
  } else {
    const ids = (env.ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    for (const id of ids) await sendMessage(token, id, message);
  }
}


// ── Webhook: respond to messages ──────────────────────────────────────
async function handleWebhook(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return new Response("Bad request", { status: 400 }); }

  const message = body?.message;
  if (!message) return new Response("OK", { status: 200 });

  const chatId  = String(message.chat?.id);
  const token   = env.TELEGRAM_BOT_TOKEN;
  const allowed = (env.ALLOWED_CHAT_IDS || "").split(",").map(s => s.trim());

  if (!allowed.includes(chatId)) {
    console.log(`Blocked chat_id: ${chatId}`);
    return new Response("OK", { status: 200 });
  }

  const { variants, folder, DAY, date, isClinicDay } = getUKDateTime();
  await sendMessage(token, chatId, buildMessage(DAY, date, variants, folder, isClinicDay));
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
