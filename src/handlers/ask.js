// /ask — natural-language questions over ClickUp tasks (scoped or all)

const clickup = require("../clickup");
const claude = require("../claude");
const { sendMessage, sendMessageChunks } = require("../telegram");

function askMaxTasks() {
  const n = parseInt(process.env.ASK_MAX_TASKS, 10);
  if (Number.isFinite(n) && n >= 30) return Math.min(n, 500);
  return 220;
}

/**
 * @returns {object|null} null if not an /ask command
 */
function parseAskCommand(text) {
  const t = text.trim();
  if (!/^\/ask(\s|$)/i.test(t)) return null;

  const rest = t.replace(/^\/ask\s*/i, "").trim();
  if (!rest) return { error: "usage" };

  const allMatch = rest.match(/^all\s+(.+)$/is);
  if (allMatch) {
    const q = allMatch[1].trim();
    if (!q) return { error: "usage" };
    return { scope: "all", question: q };
  }
  if (/^all$/i.test(rest)) return { error: "need_question_after_all" };

  const dq = rest.match(/^"([^"]+)"\s+(.+)$/is);
  if (dq) {
    return {
      scope: "location",
      location: dq[1].trim(),
      question: dq[2].trim(),
    };
  }
  const sq = rest.match(/^'([^']+)'\s+(.+)$/is);
  if (sq) {
    return {
      scope: "location",
      location: sq[1].trim(),
      question: sq[2].trim(),
    };
  }

  const uw = rest.match(/^(\S+)\s+(.+)$/is);
  if (uw) {
    return {
      scope: "location",
      location: uw[1],
      question: uw[2].trim(),
    };
  }

  return { error: "usage" };
}

function statusLabel(task) {
  return String(task.status?.status || task.status || "");
}

function daysOpen(task) {
  const ms = Number(task.date_created);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function priorityLabel(task) {
  if (!task.priority) return "none";
  return String(task.priority.priority || task.priority.id || "none");
}

function assigneeSummary(task) {
  const a = task.assignees || [];
  if (!a.length) return "";
  return a.map((x) => x.username || x.email || x.id).join(", ");
}

async function handleAskCommand(parsed) {
  if (parsed.error === "need_question_after_all") {
    await sendMessage(
      "Add your question after `all`, e.g. `/ask all What should I finish today?`",
      "Markdown"
    );
    return;
  }
  if (parsed.error) {
    await sendMessage(
      `*How to use* /ask\n\n` +
        `*All open tasks* (whole workspace):\n` +
        `\`/ask all What should I finish before 5pm?\`\n\n` +
        `*One space / folder / list* (matches ClickUp names):\n` +
        `\`/ask APS What is due today?\`\n` +
        `\`/ask "Snak King" What needs attention this week?\`\n\n` +
        `You may use \`Ask \` instead of \`/ask \`.\n` +
        `_This command only loads *tasks* in that scope — not ClickUp docs._\n\n` +
        `_Multi-word names: use quotes._`,
      "Markdown"
    );
    return;
  }

  const { question, scope, location } = parsed;
  await sendMessage("⏳ Loading tasks and thinking…", null);

  let rawTasks;
  let scopeLabel;

  try {
    if (scope === "all") {
      rawTasks = await clickup.getAllActiveTasksForTeam();
      scopeLabel = "entire workspace (all tasks)";
    } else {
      const loc = await clickup.findSpaceByName(location);
      rawTasks = await clickup.getAllActiveTasksForLocation(loc);
      scopeLabel = `"${location}" (${loc.type})`;
    }
  } catch (err) {
    await sendMessage(`❌ ${err.message || err}`, null);
    return;
  }

  const tasks = rawTasks.filter((t) => t && !t.date_closed);
  if (tasks.length === 0) {
    await sendMessage(
      `No active tasks in scope (${scopeLabel}) to answer from.`,
      null
    );
    return;
  }

  const max = askMaxTasks();
  const sorted = [...tasks].sort((a, b) => {
    const da = Number(a.due_date) || Infinity;
    const db = Number(b.due_date) || Infinity;
    if (da !== db) return da - db;
    return daysOpen(b) - daysOpen(a);
  });
  const slice = sorted.slice(0, max);
  const truncated = sorted.length - slice.length;

  const tz = process.env.TIMEZONE || "America/Mexico_City";
  let todayContext;
  try {
    const now = new Date();
    todayContext = {
      timezone: tz,
      localDate: new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(now),
      localWeekday: new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "long",
      }).format(now),
    };
  } catch {
    todayContext = { timezone: tz, note: new Date().toISOString() };
  }

  const taskDigest = slice.map((t, i) => ({
    n: i + 1,
    id: String(t.id),
    title: t.name || "(untitled)",
    status: statusLabel(t),
    due_date: t.due_date || null,
    daysOpen: daysOpen(t),
    priority: priorityLabel(t),
    assignees: assigneeSummary(t),
    space: t.space?.name || "",
    list: t.list?.name || "",
    url: t.url || `https://app.clickup.com/${process.env.CLICKUP_TEAM_ID}/t/${t.id}`,
  }));

  let answer;
  try {
    answer = await claude.answerAskAboutTasks({
      question,
      scopeDescription: scopeLabel,
      truncatedNote:
        truncated > 0
          ? `${truncated} additional tasks in scope were omitted (ASK_MAX_TASKS=${max}).`
          : null,
      todayContext,
      tasks: taskDigest,
    });
  } catch (err) {
    await sendMessage(`❌ /ask failed: ${err.message}`, null);
    return;
  }

  const header = `Ask (${scopeLabel}) — ${taskDigest.length} task(s) in snapshot${truncated ? ` (+${truncated} not sent)` : ""}\n\n`;
  await sendMessageChunks(header + answer, null);
}

module.exports = { parseAskCommand, handleAskCommand };
