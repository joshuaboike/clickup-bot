// In-memory duplicate-review sessions for meeting-generated tasks.

const sessions = new Map();

function key(chatId) {
  return String(chatId);
}

function start(chatId, session) {
  sessions.set(key(chatId), {
    ...session,
    pairIndex: 0,
    createDecisions: {}, // newIndex -> true/false
    deleteOldTaskIds: {}, // taskId -> true
  });
}

function get(chatId) {
  return sessions.get(key(chatId)) || null;
}

function clear(chatId) {
  sessions.delete(key(chatId));
}

function currentPair(session) {
  return session.pairs[session.pairIndex] || null;
}

function applyDecision(session, decision) {
  const pair = currentPair(session);
  if (!pair) return;

  const oldTask = session.existingTasks[pair.existingIndex];
  const newIndex = pair.newIndex;

  if (decision === "keep_old") {
    session.createDecisions[newIndex] = false;
  } else if (decision === "keep_new") {
    session.createDecisions[newIndex] = true;
    if (oldTask?.id) session.deleteOldTaskIds[oldTask.id] = true;
  } else if (decision === "keep_both") {
    session.createDecisions[newIndex] = true;
  } else if (decision === "skip_both") {
    session.createDecisions[newIndex] = false;
  }

  session.pairIndex += 1;
}

function parseDecision(text) {
  const t = (text || "").trim().toLowerCase();
  if (["1", "old", "keep old", "keep existing"].includes(t)) return "keep_old";
  if (["2", "new", "keep new", "replace"].includes(t)) return "keep_new";
  if (["3", "both", "keep both"].includes(t)) return "keep_both";
  if (["4", "skip", "skip both"].includes(t)) return "skip_both";
  return null;
}

module.exports = {
  start,
  get,
  clear,
  currentPair,
  applyDecision,
  parseDecision,
};
