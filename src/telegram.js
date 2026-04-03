// src/telegram.js
// All outbound Telegram calls live here.

const axios = require("axios");

const BASE = () =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Send a plain text or Markdown message to your personal chat.
 * parse_mode: "Markdown" lets you use *bold*, `code`, etc.
 * @returns {Promise<boolean>} false if the API returned an error
 */
async function sendMessage(text, parseMode = "Markdown") {
  try {
    const body = {
      chat_id: String(process.env.TELEGRAM_CHAT_ID || "").trim(),
      text,
      disable_web_page_preview: true,
    };
    if (parseMode) body.parse_mode = parseMode;
    await axios.post(`${BASE()}/sendMessage`, body);
    return true;
  } catch (err) {
    console.error("Telegram sendMessage error:", err.response?.data || err.message);
    return false;
  }
}

/** Split long Markdown across Telegram’s ~4096 limit, preferring paragraph boundaries. */
async function sendMessageChunks(text, parseMode = "Markdown", chunkSize = 3800) {
  if (!text || text.length <= chunkSize) {
    return sendMessage(text, parseMode);
  }
  let rest = text;
  let ok = true;
  while (rest.length > 0) {
    if (rest.length <= chunkSize) {
      ok = (await sendMessage(rest, parseMode)) && ok;
      break;
    }
    let cut = rest.lastIndexOf("\n\n", chunkSize);
    if (cut < chunkSize / 2) cut = rest.lastIndexOf("\n", chunkSize);
    if (cut < chunkSize / 2) cut = chunkSize;
    const chunk = rest.slice(0, cut);
    ok = (await sendMessage(chunk, parseMode)) && ok;
    rest = rest.slice(cut).trimStart();
  }
  return ok;
}

/**
 * Register your server's webhook URL with Telegram.
 * Call once on startup. Telegram will POST every incoming message to /webhook.
 */
function normalizeWebhookBase(raw) {
  let base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (!/^https:\/\//i.test(base)) {
    base = `https://${base.replace(/^\/+/, "")}`;
  }
  return base;
}

async function registerWebhook() {
  const base = normalizeWebhookBase(process.env.WEBHOOK_URL);
  if (!base) {
    throw new Error("WEBHOOK_URL is empty after trim");
  }
  const url = `${base}/webhook`;
  const res = await axios.post(`${BASE()}/setWebhook`, { url });
  console.log("Telegram setWebhook URL:", url, res.data);
}

/** Clear webhook so getUpdates (long polling) works — webhook and polling are mutually exclusive. */
async function deleteWebhook() {
  const res = await axios.post(`${BASE()}/deleteWebhook`, {
    drop_pending_updates: false,
  });
  console.log("Telegram deleteWebhook:", res.data);
}

/**
 * Long-poll for updates (local dev without public WEBHOOK_URL).
 * @param {number} offset  Pass next_update_id from previous batch; 0 on first call.
 * @param {number} timeoutSec  0–50; Telegram holds the connection up to this many seconds.
 */
async function getUpdates(offset, timeoutSec = 30) {
  const res = await axios.get(`${BASE()}/getUpdates`, {
    params: { offset, timeout: timeoutSec },
  });
  return res.data.result || [];
}

/** Where Telegram is currently sending updates (debug Railway vs local). */
async function getWebhookInfo() {
  const res = await axios.get(`${BASE()}/getWebhookInfo`);
  return res.data;
}

module.exports = {
  sendMessage,
  sendMessageChunks,
  registerWebhook,
  deleteWebhook,
  getUpdates,
  getWebhookInfo,
};
