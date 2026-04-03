// /mark_complete — batch move tasks to done using ClickUp task IDs (from /focus output)

const clickup = require("../clickup");
const { sendMessage, sendMessageChunks } = require("../telegram");

/**
 * @param {string} text full message
 * @returns {string[]|null} null if not this command
 */
function parseMarkCompleteCommand(text) {
  const trimmed = text.trim();
  if (!/^\/mark_complete\b/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^\/mark_complete\b/i, "").trim();
  if (!rest) return [];
  return rest
    .split(/[\s,]+/)
    .map((s) => s.replace(/^#/, "").trim())
    .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));
}

async function handleMarkComplete(taskIds) {
  if (!taskIds.length) {
    await sendMessage(
      "Usage: `/mark_complete` followed by one or more ClickUp task IDs (comma or space separated).\n\nExample:\n`/mark_complete 86812345,86867890`\n\nIDs appear on each task in `/focus` output.",
      "Markdown"
    );
    return;
  }

  const unique = [...new Set(taskIds)];
  await sendMessage(`⏳ Marking ${unique.length} task(s) complete in ClickUp…`, null);

  const ok = [];
  const failed = [];

  for (const id of unique) {
    try {
      const r = await clickup.markTaskComplete(id);
      ok.push({ id, status: r.status });
    } catch (err) {
      failed.push({ id, msg: err.message || String(err) });
    }
  }

  const lines = [];
  if (ok.length) {
    lines.push(`✅ Closed ${ok.length} task(s): ${ok.map((x) => x.id).join(", ")}`);
    const statuses = [...new Set(ok.map((x) => x.status))];
    if (statuses.length) lines.push(`Status used: ${statuses.join(", ")}`);
  }
  if (failed.length) {
    lines.push("");
    lines.push(`❌ Failed (${failed.length}):`);
    for (const f of failed) {
      const clip = f.msg.length > 400 ? `${f.msg.slice(0, 400)}…` : f.msg;
      lines.push(`• ${f.id}: ${clip}`);
    }
    lines.push("");
    lines.push(
      "If this persists, set CLICKUP_DONE_STATUS to the exact “done” column name for that list (use CLICKUP_DONE_STATUS_ALT if you use several names across lists)."
    );
  }

  await sendMessageChunks(lines.join("\n"), null);
}

module.exports = { parseMarkCompleteCommand, handleMarkComplete };
