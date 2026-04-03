// src/cron.js
// Scheduled digest messages: 9am and 3pm Mexico City time.
// Sends all open tasks grouped by space.

const cron = require("node-cron");
const clickup = require("./clickup");
const { sendMessage } = require("./telegram");

// Space names to include in digest — must match your ClickUp space names exactly
const DIGEST_SPACES = [
  "APS",
  "Aesop Auto Parts",
  "The Motley Fool",
  "Nth Ventures",
  "Snak King",
];

async function sendDigest(label) {
  try {
    const spaces = await getSpacesWithTasks();

    if (spaces.length === 0 || spaces.every((s) => s.tasks.length === 0)) {
      await sendMessage(`🎉 *${label} Digest* — No open tasks. Clean slate!`);
      return;
    }

    const lines = [`📋 *${label} Task Digest*`, ``];

    for (const space of spaces) {
      if (space.tasks.length === 0) continue;
      lines.push(`*${space.name}* (${space.tasks.length})`);
      for (const task of space.tasks) {
        const assignee =
          task.assignees?.length > 0
            ? ` _${task.assignees.map((a) => a.username).join(", ")}_`
            : "";
        lines.push(`  • [${task.name}](${task.url})${assignee}`);
      }
      lines.push(``);
    }

    await sendMessage(lines.join("\n"));
  } catch (err) {
    console.error("Digest error:", err.message);
    await sendMessage(`❌ Digest failed: ${err.message}`);
  }
}

async function getSpacesWithTasks() {
  const result = [];

  for (const spaceName of DIGEST_SPACES) {
    try {
      const location = await clickup.findSpaceByName(spaceName);
      const tasks = await clickup.getOpenTasksForLocation(location);
      result.push({ name: spaceName, tasks });
    } catch (err) {
      console.warn(`Could not fetch tasks for "${spaceName}":`, err.message);
    }
  }

  return result;
}

function startCronJobs() {
  // 9:00 AM Mexico City (CDT = UTC-6, CST = UTC-7)
  // "0 9 * * *" in America/Mexico_City timezone
  cron.schedule(
    "0 9 * * *",
    () => sendDigest("Morning 9am"),
    { timezone: "America/Mexico_City" }
  );

  // 3:00 PM Mexico City
  cron.schedule(
    "0 15 * * *",
    () => sendDigest("Afternoon 3pm"),
    { timezone: "America/Mexico_City" }
  );

  console.log("⏰ Cron jobs scheduled: 9am + 3pm Mexico City time");
}

module.exports = { startCronJobs, sendDigest };
