// src/handlers/task.js
// Simple handler for the "task" message type.
// Creates a single TO DO in the specified ClickUp space.

const clickup = require("../clickup");
const { sendMessage } = require("../telegram");

/**
 * @param {string} spaceName  - e.g. "Aesop Auto Parts"
 * @param {string} dateStr    - from message line 3, prefixed onto the ClickUp task title
 * @param {string} taskTitle  - line 4, the human title without date
 * @param {string} description - optional task body (line 5+)
 */
async function handleTask(spaceName, dateStr, taskTitle, description = "") {
  const fullTitle = `${dateStr} ${taskTitle}`;

  try {
    const location = await clickup.findSpaceByName(spaceName);
    const list = await clickup.getDefaultListForSpace(location);

    const task = await clickup.createTask(
      list.id,
      fullTitle,
      description,
      [process.env.CLICKUP_JOSH_USER_ID]
    );

    await sendMessage(
      `✅ Task created!\n\n*${fullTitle}*\n📋 Space: ${spaceName}\n🔗 [Open in ClickUp](${task.url})`
    );
  } catch (err) {
    console.error("Task handler error:", err.message);
    await sendMessage(`❌ Error creating task: ${err.message}`);
  }
}

module.exports = { handleTask };
