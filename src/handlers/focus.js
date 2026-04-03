// /focus — all spaces → open tasks → AI prioritization for today

const clickup = require("../clickup");
const claude = require("../claude");
const { sendMessage, sendMessageChunks } = require("../telegram");

function focusMaxTasksForAi() {
  const n = parseInt(process.env.FOCUS_MAX_TASKS_FOR_AI, 10);
  if (Number.isFinite(n) && n >= 30) return Math.min(n, 350);
  return 150;
}

/** Default: all tasks. Set FOCUS_ASSIGNEE_ONLY=1 (+ CLICKUP_JOSH_USER_ID) to filter. */
function focusAssigneeOnly() {
  const v = String(process.env.FOCUS_ASSIGNEE_ONLY || "").toLowerCase();
  if (v !== "1" && v !== "true" && v !== "yes") return false;
  return !!process.env.CLICKUP_JOSH_USER_ID;
}

function daysOpen(task) {
  const ms = Number(task.date_created);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

function priorityWeight(task) {
  const p = (task.priority && (task.priority.priority || task.priority.id)) || "";
  const s = String(p).toLowerCase();
  if (s.includes("urgent") || s === "1") return 4;
  if (s.includes("high") || s === "2") return 3;
  if (s.includes("normal") || s === "3") return 2;
  if (s.includes("low") || s === "4") return 1;
  return 0;
}

function priorityLabel(task) {
  if (!task.priority) return "none";
  return String(task.priority.priority || task.priority.id || "none");
}

function statusLabel(task) {
  return String(task.status?.status || task.status || "");
}

function taskAssignedTo(task, userId) {
  return (task.assignees || []).some((a) => String(a.id) === String(userId));
}

async function handleFocusCommand() {
  try {
    await sendMessage("⏳ Scanning all spaces and prioritizing with AI…", null);

    const assigneeId = process.env.CLICKUP_JOSH_USER_ID;
    const filterAssignee = focusAssigneeOnly();

    let rawTasks;
    try {
      rawTasks = await clickup.getAllActiveTasksForTeam();
    } catch (err) {
      await sendMessage(`❌ Could not load workspace tasks: ${err.message}`, null);
      return;
    }

    // API should respect include_closed=false; keep rows without a close date only.
    const combined = rawTasks
      .filter((t) => t && !t.date_closed)
      .map((t) => ({
        task: t,
        spaceName: (t.space && t.space.name) || "(space unknown)",
      }));

    let rows = combined;
    const totalFetched = rows.length;

    if (filterAssignee && assigneeId) {
      rows = rows.filter(({ task }) => taskAssignedTo(task, assigneeId));
    }

    if (rows.length === 0) {
      const hint = filterAssignee
        ? "No open To Do / In Progress tasks matched your assignee filter."
        : "No active (non-closed) tasks returned for your workspace.";
      await sendMessage(`🎯 Focus\n\n${hint}`, null);
      return;
    }

    const sorted = [...rows].sort((a, b) => {
      const pw = priorityWeight(b.task) - priorityWeight(a.task);
      if (pw !== 0) return pw;
      return daysOpen(b.task) - daysOpen(a.task);
    });

    const maxForAi = focusMaxTasksForAi();
    const forModel = sorted.slice(0, maxForAi);
    const truncated = sorted.length - forModel.length;

    const tasksPayload = forModel.map((row, i) => {
      const t = row.task;
      return {
        refIndex: i,
        space: row.spaceName,
        list: t.list?.name || "",
        title: t.name || "(untitled)",
        status: statusLabel(t),
        daysOpen: daysOpen(t),
        priority: priorityLabel(t),
      };
    });

    const tz = process.env.TIMEZONE || "America/Mexico_City";
    let dateLabel;
    try {
      dateLabel = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(new Date());
    } catch {
      dateLabel = new Date().toDateString();
    }

    const afterFilterNote = filterAssignee
      ? `${rows.length} after assignee-only filter`
      : `${rows.length} total (all assignees)`;

    const assigneeNote = filterAssignee
      ? "Tasks are limited to CLICKUP_JOSH_USER_ID assignee only."
      : "Tasks include every open item in each space (all owners).";

    let plan;
    try {
      plan = await claude.prioritizeTodayFocus({
        dateLabel,
        assigneeNote,
        scopeNote: `Fetched ${totalFetched} active tasks workspace-wide (All Tasks scope); ${afterFilterNote}; model sees top ${tasksPayload.length} by priority then staleness.`,
        truncatedCount: truncated,
        tasks: tasksPayload,
      });
    } catch (err) {
      await sendMessage(`❌ Focus AI failed: ${err.message}`, null);
      return;
    }

    const byRef = new Map(forModel.map((row, i) => [i, row]));

    function formatSection(title, items) {
      if (!items?.length) return "";
      const lines = [`${title}`, ""];
      for (const it of items) {
        const idx = it.refIndex;
        const row = byRef.get(idx);
        if (!row) continue;
        const t = row.task;
        const url =
          t.url ||
          `https://app.clickup.com/${process.env.CLICKUP_TEAM_ID}/t/${t.id}`;
        const why = it.why ? `\n  Why: ${String(it.why).trim()}` : "";
        lines.push(`• ${t.name || "Task"}`);
        lines.push(`  ID: ${t.id}  (for /mark_complete)`);
        lines.push(`  ${url}`);
        const loc =
          row.task.list?.name && row.task.list.name !== row.spaceName
            ? `${row.spaceName} → ${row.task.list.name}`
            : row.spaceName;
        lines.push(`  Where: ${loc}${why}`);
        lines.push("");
      }
      return lines.join("\n");
    }

    const body = [
      `🎯 Today focus — ${dateLabel}`,
      "",
      plan.summary || "(no summary)",
      "",
      formatSection("DO FIRST", plan.doFirst),
      formatSection("IF YOU HAVE TIME", plan.ifTime),
      formatSection("DEFER OR PARK", plan.deferOrPark),
      formatSection("MAYBE NOT WORTH IT", plan.maybeNotWorthIt),
      `—`,
      `Model ranked ${tasksPayload.length} task(s)${
        truncated ? `; ${truncated} more not sent to save context` : ""
      }.`,
      filterAssignee ? "Scope: your assignments only." : "Scope: all tasks (every assignee).",
      "",
      "—",
      "Already finished something? Copy its ID line above, then send:",
      "/mark_complete id1,id2,id3",
      "(Spaces or commas between IDs. Not the same as meeting /done.)",
    ].join("\n");

    await sendMessageChunks(body, null);
  } catch (err) {
    console.error("handleFocusCommand:", err);
    await sendMessage(`❌ Focus failed: ${err.message || err}`, null);
  }
}

module.exports = { handleFocusCommand };
