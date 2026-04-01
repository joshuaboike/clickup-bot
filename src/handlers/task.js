// src/handlers/task.js
// Simple handler for the "task" message type.
// Creates a single TO DO in the specified ClickUp space.

const clickup = require("../clickup");
const { sendMessage } = require("../telegram");

/**
 * @param {string} spaceName  - e.g. "Aesop Auto Parts"
 * @param {string} taskName   - e.g. "Follow up with Tom on data access"
 * @param {string} description - optional task body
 */
async function handleTask(spaceName, taskName, description = "") {
  await sendMessage(`⏳ Creating task: *${taskName}*...`);

  try {
    const space = await clickup.findSpaceByName(spaceName);
    const list = await clickup.getDefaultListForSpace(space.id);

    const task = await clickup.createTask(
      list.id,
      taskName,
      description,
      [process.env.CLICKUP_JOSH_USER_ID] // always assign to Josh for manual tasks
    );

    await sendMessage(
      `✅ Task created!\n\n*${taskName}*\n📋 Space: ${spaceName}\n🔗 [Open in ClickUp](${task.url})`
    );
  } catch (err) {
    console.error("Task handler error:", err.message);
    await sendMessage(`❌ Error creating task: ${err.message}`);
  }
}

module.exports = { handleTask };
