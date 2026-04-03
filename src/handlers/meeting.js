// src/handlers/meeting.js
// Orchestrates the full meeting flow:
// 1. Analyze transcript with Claude
// 2. Create a ClickUp Doc with the summary + raw transcript
// 3. Create tasks from the todos (assign to Josh or prefix with [NAME])
// 4. Reply to Telegram with success or failure only

const axios = require("axios");
const clickup = require("../clickup");
const claude = require("../claude");
const { formatAxiosError } = require("../httpErrors");
const { sendMessage } = require("../telegram");
const duplicateReview = require("../duplicateReview");

function normalizeTodo(todo) {
  const person = String(todo?.person || "Josh").trim() || "Josh";
  const task = String(todo?.task || "").trim();
  const isJosh = person.toLowerCase() === "josh" || person.toLowerCase() === "me";
  const baseName = isJosh ? task : `[${person.toUpperCase()}] ${task}`;
  const assignees = isJosh ? [process.env.CLICKUP_JOSH_USER_ID] : [];
  return { person, task, baseName, assignees };
}

async function createTasksFromCandidates(listId, candidates) {
  const created = [];
  for (const c of candidates) {
    const task = await clickup.createTask(listId, c.taskName, c.description, c.assignees);
    created.push({ id: task.id, name: c.taskName, url: task.url });
  }
  return created;
}

function buildPairPrompt(session) {
  const pair = duplicateReview.currentPair(session);
  if (!pair) return null;
  const oldTask = session.existingTasks[pair.existingIndex];
  const newTask = session.newCandidates[pair.newIndex];
  const idx = session.pairIndex + 1;
  const total = session.pairs.length;
  return (
    `Potential duplicate ${idx}/${total}\n\n` +
    `Existing:\n- ${oldTask?.name || "(missing)"}\n\n` +
    `New:\n- ${newTask?.taskName || "(missing)"}\n\n` +
    `Reason: ${pair.reason || "Likely same work"}\n\n` +
    `Reply with:\n` +
    `1 = keep existing (skip new)\n` +
    `2 = keep new (delete existing)\n` +
    `3 = keep both\n` +
    `4 = skip both`
  );
}

/**
 * Main meeting handler.
 * @param {string} spaceName - e.g. "Snak King"
 * @param {string} dateStr - from your message line 3 (e.g. 03.27.26), never inferred
 * @param {string} itemName - e.g. "meeting with Jen and Mark"
 * @param {string} transcript - raw meeting transcript
 * @param {string|number} chatId - telegram chat id for interactive duplicate review
 */
async function handleMeeting(spaceName, dateStr, itemName, transcript, chatId) {
  try {
    // ── Step 1: Find the ClickUp space or folder ────────────────────────────
    const location = await clickup.findSpaceByName(spaceName);
    const list = await clickup.getDefaultListForSpace(location);

    // ── Step 2: Analyze with Claude ─────────────────────────────────────────
    const analysis = await claude.analyzeMeeting(transcript);

    // ── Step 3: Build the doc title and content ──────────────────────────────
    const docTitle = `${dateStr}_${itemName}`;

    const todos = Array.isArray(analysis.todos) ? analysis.todos : [];

    const docContent = [
      `## Meeting Summary`,
      ``,
      analysis.summary || "(no summary)",
      ``,
      `---`,
      ``,
      `## Action Items`,
      ``,
      todos
        .map((t) => `- **${t.person}**: ${t.task}`)
        .join("\n"),
      ``,
      `---`,
      ``,
      `## Raw Transcript`,
      ``,
      transcript,
    ].join("\n");

    // ── Step 4: Create the Doc ───────────────────────────────────────────────
    const doc = await clickup.createDoc(location, docTitle, docContent);

    // ── Step 5: Create tasks from todos ─────────────────────────────────────
    const newCandidates = [];
    for (const rawTodo of todos) {
      const todo = normalizeTodo(rawTodo);
      if (!todo.task) continue;
      const taskName = `${dateStr} ${todo.baseName}`;
      const description = `**From meeting:** [${docTitle}](${doc.url})\n\n${todo.task}`;
      newCandidates.push({
        taskName,
        description,
        assignees: todo.assignees,
      });
    }

    const existingTasks = await clickup.getOpenTasksForLocation(location);
    const pairs = await claude.findPotentialTaskDuplicates(
      existingTasks.map((t) => t.name || ""),
      newCandidates.map((t) => t.taskName)
    );

    if (pairs.length > 0 && chatId != null) {
      duplicateReview.start(chatId, {
        listId: String(list.id),
        existingTasks: existingTasks.map((t) => ({ id: String(t.id), name: t.name || "" })),
        newCandidates,
        pairs,
      });
      await sendMessage(
        `${pairs.length} pairs of potential duplicates found. Beginning review one by one.`,
        null
      );
      const first = buildPairPrompt(duplicateReview.get(chatId));
      if (first) await sendMessage(first, null);
      return;
    }

    const createdTasks = await createTasksFromCandidates(list.id, newCandidates);

    // ── Step 6: One-line Telegram confirmation ─────────────────────────────
    const n = createdTasks.length;
    const taskWord = n === 1 ? "task" : "tasks";
    const ok = await sendMessage(
      `✅ Transcript successfully turned into summary and outputs and created in doc -- ${n} new ${taskWord} created.`,
      null
    );
    if (!ok) console.error("Telegram: failed to send completion message");
  } catch (err) {
    let msg = err.message || String(err);
    if (axios.isAxiosError(err)) {
      msg = formatAxiosError(err, "API");
    }
    console.error("Meeting handler error:", msg);
    const clip = msg.length > 1200 ? `${msg.slice(0, 1200)}…` : msg;
    await sendMessage(`❌ Error processing meeting:\n\n${clip}`, null);
  }
}

async function handleDuplicateDecision(chatId, text) {
  const session = duplicateReview.get(chatId);
  if (!session) return false;
  if (String(text || "").trim().startsWith("/")) return false;

  const decision = duplicateReview.parseDecision(text);
  if (!decision) {
    await sendMessage(
      `I didn't catch that. Reply with 1, 2, 3, or 4.\n` +
        `1 keep existing · 2 keep new · 3 keep both · 4 skip both`,
      null
    );
    return true;
  }

  duplicateReview.applyDecision(session, decision);
  const next = buildPairPrompt(session);
  if (next) {
    await sendMessage(next, null);
    return true;
  }

  // Finalize after all pair decisions
  const createSet = new Set();
  for (let i = 0; i < session.newCandidates.length; i += 1) {
    if (!(i in session.createDecisions)) {
      createSet.add(i); // non-flagged task defaults to create
    } else if (session.createDecisions[i] === true) {
      createSet.add(i);
    }
  }

  const toCreate = [...createSet].map((i) => session.newCandidates[i]);
  const toDelete = Object.keys(session.deleteOldTaskIds);

  const created = await createTasksFromCandidates(session.listId, toCreate);
  let deletedCount = 0;
  for (const id of toDelete) {
    try {
      await clickup.deleteTaskById(id);
      deletedCount += 1;
    } catch (err) {
      console.warn(`Could not delete duplicate old task ${id}: ${err.message}`);
    }
  }

  duplicateReview.clear(chatId);
  await sendMessage(
    `✅ Duplicate review complete. Created ${created.length} tasks; deleted ${deletedCount} replaced existing tasks.`,
    null
  );
  return true;
}

function cancelDuplicateReview(chatId) {
  if (!duplicateReview.get(chatId)) return false;
  duplicateReview.clear(chatId);
  return true;
}

module.exports = { handleMeeting, handleDuplicateDecision, cancelDuplicateReview };
