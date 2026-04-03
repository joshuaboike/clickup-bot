// src/index.js
// Express server. Handles incoming Telegram webhooks and routes to the
// correct handler based on message type.

require("dotenv").config();

const express = require("express");
const {
  registerWebhook,
  deleteWebhook,
  getUpdates,
  getWebhookInfo,
  sendMessage,
} = require("./telegram");

const BUILD = "2026-04-01-meeting-buffer";
const { parseMessage } = require("./parser");
const meetingBuffer = require("./meetingBuffer");
const {
  handleMeeting,
  handleDuplicateDecision,
  cancelDuplicateReview,
} = require("./handlers/meeting");
const { handleTask } = require("./handlers/task");
const { handleSandboxBulkDelete } = require("./handlers/sandboxDelete");
const { handleFocusCommand } = require("./handlers/focus");
const {
  parseMarkCompleteCommand,
  handleMarkComplete,
} = require("./handlers/markComplete");
const { parseQueryCommand, handleQueryCommand } = require("./handlers/query");
const { parseAskCommand, handleAskCommand } = require("./handlers/ask");
const {
  parseComposeCommand,
  handleComposeCommand,
} = require("./handlers/composeDoc");
const { startCronJobs, sendDigest } = require("./cron");

const app = express();
app.use(express.json());

/**
 * /sandbox_delete list Snak King [delete]  OR  /sandbox_delete Snak King list [delete]
 * (folder must match ClickUp folder name, e.g. Snak King under Client Projects)
 */
function parseSandboxDeleteCommand(text) {
  const targetFirst = text.match(
    /^\/sandbox_delete\s+(list|docs)\s+(.+?)(?:\s+delete)?\s*$/i
  );
  if (targetFirst) {
    return {
      target: targetFirst[1].toLowerCase(),
      folder: targetFirst[2].trim(),
    };
  }
  const folderFirst = text.match(
    /^\/sandbox_delete\s+(.+)\s+(list|docs)(?:\s+delete)?\s*$/i
  );
  if (folderFirst) {
    return {
      target: folderFirst[2].toLowerCase(),
      folder: folderFirst[1].trim(),
    };
  }
  return null;
}

/**
 * Process one Telegram message (shared by webhook and long polling).
 * Ignores chats other than TELEGRAM_CHAT_ID when that env is set.
 */
async function handleTelegramMessage(message) {
  const allowed = String(process.env.TELEGRAM_CHAT_ID || "");
  if (allowed && String(message.chat?.id) !== allowed) return;

  if (!message.text) return;
  let text = message.text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

  // "Ask …" without a slash → same routing as /ask (otherwise this hits task/meeting parser).
  if (/^ask\s+/i.test(text) && !/^\/ask(\s|$)/i.test(text)) {
    text = `/ask ${text.replace(/^ask\s+/i, "").trimStart()}`;
  }
  if (/^Compose\s+/.test(text) && !/^\/compose(\s|$)/i.test(text)) {
    text = `/compose ${text.replace(/^Compose\s+/, "").trimStart()}`;
  }
  if (/^Query\s+/.test(text) && !/^\/query(\s|$)/i.test(text)) {
    text = `/query ${text.replace(/^Query\s+/, "").trimStart()}`;
  }

  // ── Special commands ────────────────────────────────────────────────────
  const sandboxParsed = parseSandboxDeleteCommand(text);
  if (sandboxParsed) {
    handleSandboxBulkDelete(sandboxParsed.target, sandboxParsed.folder).catch(
      (e) => console.error(e)
    );
    return;
  }

  if (text === "/digest") {
    await sendDigest("Manual");
    return;
  }

  if (text === "/focus" || text === "/today") {
    handleFocusCommand().catch((e) => console.error("focus:", e));
    return;
  }

  const markIds = parseMarkCompleteCommand(text);
  if (markIds !== null) {
    handleMarkComplete(markIds).catch((e) => console.error("mark_complete:", e));
    return;
  }

  const composeParsed = parseComposeCommand(text);
  if (composeParsed !== null) {
    handleComposeCommand(composeParsed).catch((e) =>
      console.error("compose:", e)
    );
    return;
  }

  const queryParsed = parseQueryCommand(text);
  if (queryParsed !== null) {
    handleQueryCommand(queryParsed).catch((e) => console.error("query:", e));
    return;
  }

  const askParsed = parseAskCommand(text);
  if (askParsed !== null) {
    handleAskCommand(askParsed).catch((e) => console.error("ask:", e));
    return;
  }

  if (text === "/help") {
    await sendMessage(
      `*DDC ClickUp Bot*\n\n` +
        `🔹 *Task*\n` +
        `\`\`\`\ntask\nAPS\n03.27.26\nFollow up with Mark\nOptional description\n\`\`\`\n\n` +
        `🔹 *Meeting* (all in *one message*, line 5+ = transcript)\n` +
        `\`\`\`\nmeeting\nSnak King\n03.27.26\nmeeting with Jen and Mark\n<first line of transcript>\n\`\`\`\n\n` +
        `Long transcripts don’t fit one bubble — send the 4-line header first (type → location → date → title), then paste the rest in *more messages*, then send:\n` +
        `\`/done\` — process  ·  \`/cancel\` — discard\n\n` +
        `If potential duplicate tasks are found, I will pause and ask one-by-one what to keep (reply 1/2/3/4).\n\n` +
        `*Sandbox (destructive):*\n` +
        `\`/sandbox_delete Snak King list delete\` — folder first (matches your ClickUp folder)\n` +
        `or \`/sandbox_delete list Snak King\` — same thing, other word order\n` +
        `\`/sandbox_delete Snak King docs delete\` — remove docs (if ClickUp API allows; often use UI)\n\n` +
        `*Commands:* /digest · /focus · /compose · /query · /ask · /mark_complete · /help\n\n` +
        `*Query (tasks + recent docs → answer):*\n` +
        `\`/query all What themes appear in client work?\`\n` +
        `\`/query SolisRx What did we commit to with Catalant?\`\n` +
        `(Or \`Query \` with capital Q.)\n\n` +
        `*Compose (new doc from an existing doc, AI picks source):*\n` +
        `\`/compose SolisRx Draft a proposal from the latest Catalant call notes\`\n` +
        `\`/compose all Summarize the newest client meeting doc\`\n` +
        `(Or start with \`Compose \` — same as \`/compose \`.)\n\n` +
        `*Ask (tasks only):*\n` +
        `\`/ask all What should I finish today?\`\n` +
        `\`/ask APS What is due this week?\`\n` +
        `\`/ask "Snak King" Any blockers?\`\n` +
        `(Or \`Ask \` without slash.)\n` +
        `_Note: /ask only sees *tasks*. Use /query to include recent doc excerpts._\n\n` +
        `After /focus, use ClickUp *ID:* values with:\n` +
        `\`/mark_complete 86812345,86867890\``
    );
    return;
  }

  const chatId = message.chat?.id;
  const pending = meetingBuffer.get(chatId);

  const consumedByDuplicateReview = await handleDuplicateDecision(chatId, text);
  if (consumedByDuplicateReview) return;

  if (text === "/done") {
    const buf = meetingBuffer.take(chatId);
    if (!buf) {
      await sendMessage(
        `No meeting transcript in progress. Start with a 4-line header:\n\`meeting\` → location → date → title`
      );
      return;
    }
    const transcript = buf.parts.join("\n\n").trim();
    if (!transcript) {
      await sendMessage(`❌ No transcript text was collected. Start again with the 4-line header.`);
      return;
    }
    handleMeeting(buf.spaceName, buf.dateStr, buf.itemName, transcript, chatId);
    return;
  }

  if (text === "/cancel") {
    if (cancelDuplicateReview(chatId)) {
      await sendMessage(`Duplicate review cancelled. No meeting tasks were created from that review.`);
      return;
    }
    if (meetingBuffer.get(chatId)) {
      meetingBuffer.cancel(chatId);
      await sendMessage(`Meeting draft cancelled.`);
    } else {
      await sendMessage(`Nothing to cancel.`);
    }
    return;
  }

  const parsed = parseMessage(text);

  if (pending) {
    if (!parsed.error) {
      if (parsed.type === "task") {
        meetingBuffer.cancel(chatId);
        handleTask(parsed.spaceName, parsed.dateStr, parsed.itemName, parsed.contents);
        return;
      }
      if (parsed.type === "meeting" && parsed.contents) {
        meetingBuffer.cancel(chatId);
        handleMeeting(
          parsed.spaceName,
          parsed.dateStr,
          parsed.itemName,
          parsed.contents,
          chatId
        );
        return;
      }
      if (parsed.type === "meeting" && !parsed.contents) {
        meetingBuffer.start(chatId, parsed.spaceName, parsed.dateStr, parsed.itemName);
        await sendMessage(
          `Meeting header updated (${parsed.dateStr}): *${parsed.itemName}*\n\n` +
            `Keep pasting transcript chunks, then send \`/done\` when finished. \`/cancel\` to abort.`
        );
        return;
      }
    }
    meetingBuffer.append(chatId, text);
    return;
  }

  if (parsed.error) {
    await sendMessage(`❌ Parse error: ${parsed.error}`);
    return;
  }

  const { type, spaceName, dateStr, itemName, contents } = parsed;

  if (type === "meeting") {
    if (!contents) {
      meetingBuffer.start(chatId, spaceName, dateStr, itemName);
      await sendMessage(
        `*${dateStr} ${itemName}* — waiting for transcript.\n\n` +
          `Paste the rest in one or more messages (Telegram splits long pastes). ` +
          `When everything is sent, reply with \`/done\`. \`/cancel\` to abort.`
      );
      return;
    }
    handleMeeting(spaceName, dateStr, itemName, contents, chatId);
  } else if (type === "task") {
    handleTask(spaceName, dateStr, itemName, contents);
  }
}

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "DDC ClickUp Bot is running 🚀",
    build: BUILD,
    hint: "If Telegram acts old, hit this URL on the host that should run the bot.",
  });
});

// ── Telegram webhook ──────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const message = req.body?.message;
  if (message) {
    handleTelegramMessage(message).catch((e) => console.error(e));
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
  console.log(`✅ Server running on port ${PORT} (build ${BUILD})`);

  if (process.env.WEBHOOK_URL) {
    await registerWebhook();
  } else {
    await deleteWebhook();
    console.log("📥 WEBHOOK_URL unset — using Telegram long polling (local-friendly).");
    startLongPolling();
  }

  try {
    const info = await getWebhookInfo();
    const wh = info?.result?.url;
    if (wh) {
      console.log(`📡 Telegram webhook active → ${wh} (updates do NOT go to long polling on another machine)`);
    } else {
      console.log("📡 Telegram webhook empty — updates via long polling on this process (or another instance cleared it).");
    }
  } catch (e) {
    console.warn("Could not fetch getWebhookInfo:", e.message);
  }

  startCronJobs();

  console.log("🤖 DDC ClickUp Bot is live.");
});

function startLongPolling() {
  let offset = 0;
  const loop = async () => {
    for (;;) {
      try {
        const updates = await getUpdates(offset);
        for (const u of updates) {
          offset = u.update_id + 1;
          if (u.message) {
            handleTelegramMessage(u.message).catch((e) => console.error(e));
          }
        }
      } catch (err) {
        console.error("getUpdates error:", err.response?.data || err.message);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  };
  loop().catch((e) => console.error("long polling crashed:", e));
}
