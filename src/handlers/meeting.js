// src/handlers/meeting.js
// Orchestrates the full meeting flow:
// 1. Analyze transcript with Claude
// 2. Create a ClickUp Doc with the summary + raw transcript
// 3. Create tasks from the todos (assign to Josh or prefix with [NAME])
// 4. Reply to Telegram with the summary

const clickup = require("../clickup");
const claude = require("../claude");
const { sendMessage } = require("../telegram");
const { formatDate } = require("../utils");

/**
 * Main meeting handler.
 * @param {string} spaceName - e.g. "APS"
 * @param {string} itemName  - e.g. "Weekly Sync with Mark & Jen"
 * @param {string} transcript - raw meeting transcript
 */
async function handleMeeting(spaceName, itemName, transcript) {
  await sendMessage(`⏳ Processing meeting: *${itemName}*...`);

  try {
    // ── Step 1: Find the ClickUp space ──────────────────────────────────────
    const space = await clickup.findSpaceByName(spaceName);
    const list = await clickup.getDefaultListForSpace(space.id);

    // ── Step 2: Analyze with Claude ─────────────────────────────────────────
    await sendMessage(`🧠 Analyzing transcript...`);
    const analysis = await claude.analyzeMeeting(transcript);

    // ── Step 3: Build the doc title and content ──────────────────────────────
    const dateStr = formatDate(new Date()); // DD.MM.YY
    const docTitle = `${dateStr}_${itemName}`;

    const docContent = [
      `## Meeting Summary`,
      ``,
      analysis.summary,
      ``,
      `---`,
      ``,
      `## Action Items`,
      ``,
      analysis.todos
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
    await sendMessage(`📄 Creating ClickUp doc...`);
    const doc = await clickup.createDoc(space.id, docTitle, docContent);

    // ── Step 5: Create tasks from todos ─────────────────────────────────────
    await sendMessage(`✅ Creating tasks...`);
    const createdTasks = [];

    for (const todo of analysis.todos) {
      const isJosh =
        todo.person.toLowerCase() === "josh" ||
        todo.person.toLowerCase() === "me";

      const taskName = isJosh
        ? todo.task
        : `[${todo.person.toUpperCase()}] ${todo.task}`;

      const assignees = isJosh ? [process.env.CLICKUP_JOSH_USER_ID] : [];

      const description = `**From meeting:** [${docTitle}](${doc.url})\n\n${todo.task}`;

      const task = await clickup.createTask(
        list.id,
        taskName,
        description,
        assignees
      );
      createdTasks.push({ name: taskName, url: task.url });
    }

    // ── Step 6: Reply to Telegram ────────────────────────────────────────────
    const taskLines = createdTasks
      .map((t) => `  • [${t.name}](${t.url})`)
      .join("\n");

    const reply = [
      `✅ *Meeting processed: ${itemName}*`,
      ``,
      `📄 Doc: [${docTitle}](${doc.url})`,
      ``,
      `*Summary:*`,
      analysis.summary,
      ``,
      `*Tasks created (${createdTasks.length}):*`,
      taskLines,
    ].join("\n");

    await sendMessage(reply);
  } catch (err) {
    console.error("Meeting handler error:", err.message);
    await sendMessage(
      `❌ Error processing meeting: ${err.message}\n\nCheck logs for details.`
    );
  }
}

module.exports = { handleMeeting };
