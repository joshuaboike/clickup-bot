// /query — AI answers from open tasks + recent ClickUp docs in scope (or workspace-wide)

const clickup = require("../clickup");
const claude = require("../claude");
const { sendMessage, sendMessageChunks } = require("../telegram");

function queryMaxTasks() {
  const q = parseInt(process.env.QUERY_MAX_TASKS, 10);
  if (Number.isFinite(q) && q >= 20) return Math.min(q, 500);
  const a = parseInt(process.env.ASK_MAX_TASKS, 10);
  if (Number.isFinite(a) && a >= 30) return Math.min(a, 500);
  return 220;
}

function queryMaxDocs() {
  const n = parseInt(process.env.QUERY_MAX_DOCS, 10);
  if (Number.isFinite(n) && n >= 1) return Math.min(n, 40);
  return 15;
}

function queryMaxCharsPerDoc() {
  const n = parseInt(process.env.QUERY_MAX_CHARS_PER_DOC, 10);
  if (Number.isFinite(n) && n >= 2000) return Math.min(n, 80_000);
  return 8000;
}

/**
 * @returns {object|null} null if not a /query command
 */
function parseQueryCommand(text) {
  const t = text.trim();
  if (!/^\/query(\s|$)/i.test(t)) return null;

  const rest = t.replace(/^\/query\s*/i, "").trim();
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

function docUpdatedMs(d) {
  const v = d.date_updated || d.date_edited || d.updated_at || d.created_at || 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

async function handleQueryCommand(parsed) {
  if (parsed.error === "need_question_after_all") {
    await sendMessage(
      "Add your question after `all`, e.g. `/query all What themes show up in recent client docs?`",
      "Markdown"
    );
    return;
  }
  if (parsed.error) {
    await sendMessage(
      `*Query* — tasks + recent docs → one answer\n\n` +
        `*Whole workspace:*\n` +
        `\`/query all What did we commit to on Catalant across docs and tasks?\`\n\n` +
        `*One space / folder / list:*\n` +
        `\`/query SolisRx Summarize open work and latest meeting notes\`\n` +
        `\`/query "Snak King" Any risks called out in docs or tasks?\`\n\n` +
        `Or start with \`Query \` (capital Q) instead of \`/query \`.\n\n` +
        `_Loads open tasks (like /ask) plus the N most recently updated docs in scope; long docs are truncated._\n\n` +
        `_For task-only questions, \`/ask\` is lighter._`,
      "Markdown"
    );
    return;
  }

  const { question, scope, location } = parsed;
  await sendMessage("⏳ Loading tasks + docs…", null);

  let rawTasks;
  let rawDocs;
  let scopeLabel;

  try {
    if (scope === "all") {
      rawTasks = await clickup.getAllActiveTasksForTeam();
      rawDocs = await clickup.listAllDocsInWorkspace();
      scopeLabel = "entire workspace";
    } else {
      const loc = await clickup.findSpaceByName(location);
      rawTasks = await clickup.getAllActiveTasksForLocation(loc);
      rawDocs = await clickup.listAllDocsForLocation(loc);
      scopeLabel = `"${location}" (${loc.type})`;
    }
  } catch (err) {
    await sendMessage(`❌ ${err.message || err}`, null);
    return;
  }

  const tasks = rawTasks.filter((t) => t && !t.date_closed);
  const docsMeta = (rawDocs || [])
    .filter((d) => d && !d.deleted && d.id && d.name)
    .sort((a, b) => docUpdatedMs(b) - docUpdatedMs(a));

  const maxDocs = queryMaxDocs();
  const maxChars = queryMaxCharsPerDoc();
  const docSlice = docsMeta.slice(0, maxDocs);
  const docsOmitted = docsMeta.length - docSlice.length;

  const docPayload = [];
  for (const d of docSlice) {
    const url = `https://app.clickup.com/${process.env.CLICKUP_TEAM_ID}/docs/${d.id}`;
    let excerpt = "";
    try {
      const full = await clickup.getDocMarkdownById(d.id);
      excerpt =
        full.length > maxChars
          ? full.slice(0, maxChars) + "\n\n[…truncated…]"
          : full;
    } catch (err) {
      excerpt = `(Could not read body: ${err.message})`;
    }
    docPayload.push({
      id: String(d.id),
      name: d.name,
      url,
      excerpt,
    });
  }

  const maxT = queryMaxTasks();
  const sortedTasks = [...tasks].sort((a, b) => {
    const da = Number(a.due_date) || Infinity;
    const db = Number(b.due_date) || Infinity;
    if (da !== db) return da - db;
    return daysOpen(b) - daysOpen(a);
  });
  const taskSlice = sortedTasks.slice(0, maxT);
  const tasksOmitted = sortedTasks.length - taskSlice.length;

  if (taskSlice.length === 0 && docPayload.length === 0) {
    await sendMessage(
      `Nothing to read in scope (${scopeLabel}): no open tasks and no docs found.`,
      null
    );
    return;
  }

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
    };
  } catch {
    todayContext = { timezone: tz };
  }

  const taskDigest = taskSlice.map((t, i) => ({
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
    answer = await claude.answerUnifiedQuery({
      question,
      scopeDescription: scopeLabel,
      todayContext,
      tasks: taskDigest,
      docs: docPayload,
      limitsNote: [
        tasksOmitted > 0
          ? `${tasksOmitted} tasks omitted (QUERY_MAX_TASKS / ASK_MAX_TASKS cap).`
          : null,
        docsOmitted > 0
          ? `${docsOmitted} docs omitted (only ${docPayload.length} most recently updated included).`
          : null,
        `Up to ${maxChars} characters per doc excerpt.`,
      ]
        .filter(Boolean)
        .join(" "),
    });
  } catch (err) {
    await sendMessage(`❌ /query failed: ${err.message}`, null);
    return;
  }

  const header =
    `Query (${scopeLabel})\n` +
    `${taskDigest.length} task(s), ${docPayload.length} doc excerpt(s)\n\n`;
  await sendMessageChunks(header + answer, null);
}

module.exports = { parseQueryCommand, handleQueryCommand };
