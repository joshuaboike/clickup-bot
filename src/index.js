// src/index.js
// Express server. Handles incoming Telegram webhooks and routes to the
// correct handler based on message type.

require("dotenv").config();

const express = require("express");
const { registerWebhook, sendMessage } = require("./telegram");
const { parseMessage } = require("./parser");
const { handleMeeting } = require("./handlers/meeting");
const { handleTask } = require("./handlers/task");
const { startCronJobs, sendDigest } = require("./cron");

const app = express();
app.use(express.json());

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "DDC ClickUp Bot is running 🚀" });
});

// ── Telegram webhook ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Always respond 200 immediately so Telegram doesn't retry
  res.sendStatus(200);

  const message = req.body?.message;
  if (!message?.text) return;

  const text = message.text.trim();

  // ── Special commands ────────────────────────────────────────────────────
  // /digest — trigger a manual digest right now
  if (text === "/digest") {
    await sendDigest("Manual");
    return;
  }

  // /help — show usage
  if (text === "/help") {
    await sendMessage(
      `*DDC ClickUp Bot*\n\n` +
      `*Create a task:*\n` +
      `\`\`\`\ntask\nAPS\nFollow up with Mark\nOptional description here\n\`\`\`\n\n` +
      `*Process a meeting:*\n` +
      `\`\`\`\nmeeting\nAPS\n3.27.26 Weekly Sync\n<paste full transcript here>\n\`\`\`\n\n` +
      `*Commands:*\n` +
      `/digest — get your task digest now\n` +
      `/help — show this message`
    );
    return;
  }

  // ── Parse structured message ────────────────────────────────────────────
  const parsed = parseMessage(text);

  if (parsed.error) {
    await sendMessage(`❌ Parse error: ${parsed.error}`);
    return;
  }

  const { type, spaceName, itemName, contents } = parsed;

  // ── Route to handler ────────────────────────────────────────────────────
  if (type === "meeting") {
    if (!contents) {
      await sendMessage(
        `❌ Meeting type requires transcript contents (line 4+).`
      );
      return;
    }
    // Don't await — process async, respond to Telegram progressively
    handleMeeting(spaceName, itemName, contents);
  } else if (type === "task") {
    handleTask(spaceName, itemName, contents);
  }
});

// ── Admin endpoint: manually trigger digest ───────────────────────────────────
app.get("/trigger-digest", async (req, res) => {
  await sendDigest("Manual Trigger");
  res.json({ ok: true });
});

// ── Startup ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT}`);

  // Register webhook with Telegram (safe to call repeatedly)
  if (process.env.WEBHOOK_URL) {
    await registerWebhook();
  } else {
    console.warn("⚠️  WEBHOOK_URL not set — skipping Telegram webhook registration");
    console.warn("   Set this after your first Railway deploy.");
  }

  // Start scheduled digests
  startCronJobs();

  console.log("🤖 DDC ClickUp Bot is live.");
});
