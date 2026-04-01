// src/telegram.js
// All outbound Telegram calls live here.

const axios = require("axios");

const BASE = () =>
  `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

/**
 * Send a plain text or Markdown message to your personal chat.
 * parse_mode: "Markdown" lets you use *bold*, `code`, etc.
 */
async function sendMessage(text, parseMode = "Markdown") {
  try {
    await axios.post(`${BASE()}/sendMessage`, {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("Telegram sendMessage error:", err.response?.data || err.message);
  }
}

/**
 * Register your server's webhook URL with Telegram.
 * Call once on startup. Telegram will POST every incoming message to /webhook.
 */
async function registerWebhook() {
  const url = `${process.env.WEBHOOK_URL}/webhook`;
  const res = await axios.post(`${BASE()}/setWebhook`, { url });
  console.log("Telegram webhook registered:", res.data);
}

module.exports = { sendMessage, registerWebhook };
