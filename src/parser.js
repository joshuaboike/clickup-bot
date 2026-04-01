// src/parser.js
// Parses the structured message format you send via Telegram.
//
// Expected format:
//   [item type]
//   [space name]
//   [item name]
//   [item contents - optional, can be multi-line]
//
// Examples:
//   meeting
//   APS
//   3.27.26 Weekly Sync with Mark & Jen
//   <transcript text here...>
//
//   task
//   Aesop Auto Parts
//   Follow up with Tom on data access
//   Send him the credentials doc and confirm Snowflake access

function parseMessage(text) {
  if (!text || typeof text !== "string") {
    return { error: "Empty message" };
  }

  const lines = text.trim().split("\n");

  if (lines.length < 3) {
    return {
      error:
        "Message must have at least 3 lines:\n[type]\n[space name]\n[item name]",
    };
  }

  const type = lines[0].trim().toLowerCase();
  const spaceName = lines[1].trim();
  const itemName = lines[2].trim();
  const contents = lines.slice(3).join("\n").trim(); // everything after line 3

  const validTypes = ["meeting", "task"];
  if (!validTypes.includes(type)) {
    return {
      error: `Unknown type "${type}". Valid types: meeting, task`,
    };
  }

  return { type, spaceName, itemName, contents };
}

module.exports = { parseMessage };
