// src/parser.js
// Parses the structured message format you send via Telegram.
//
// Expected format:
//   [item type]
//   [space / folder / list name]
//   [date — exactly as you type it, e.g. 03.27.26]
//   [item / meeting title]
//   [optional body: task description or meeting transcript start...]
//
// Examples:
//   meeting
//   Snak King
//   03.27.26
//   meeting with Jen and Mark
//   <transcript...>
//
//   task
//   Aesop Auto Parts
//   03.27.26
//   Follow up with Tom
//   Optional longer description

function parseMessage(text) {
  if (!text || typeof text !== "string") {
    return { error: "Empty message" };
  }

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lines = normalized.split("\n");

  if (lines.length < 4) {
    return {
      error:
        "Message must have at least 4 lines:\n[type]\n[space/folder/list]\n[date]\n[title]",
    };
  }

  const type = lines[0].trim().toLowerCase();
  const spaceName = lines[1].trim();
  const dateStr = lines[2].trim();
  const itemName = lines[3].trim();
  const contents = lines.slice(4).join("\n").trim();

  const validTypes = ["meeting", "task"];
  if (!validTypes.includes(type)) {
    return {
      error: `Unknown type "${type}". Valid types: meeting, task`,
    };
  }

  if (!dateStr) {
    return { error: "Line 3 (date) cannot be empty." };
  }
  if (!itemName) {
    return { error: "Line 4 (title) cannot be empty." };
  }

  return { type, spaceName, dateStr, itemName, contents };
}

module.exports = { parseMessage };
