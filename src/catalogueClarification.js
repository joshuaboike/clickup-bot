// src/catalogueClarification.js
// State machine for APS-transcript catalogue clarification Q&A over Telegram.
// Modeled on duplicateReview.js. Only one active session per chatId.

const sessions = new Map(); // chatId → { questions, answers, onComplete }

function start(chatId, { questions, context, onComplete }) {
  sessions.set(chatId, {
    questions,            // [{ question: string, options: string[] }]
    context,              // arbitrary payload passed to onComplete
    answers: {},          // index → chosen option or null
    cursor: 0,
    onComplete,
  });
}

function get(chatId) {
  return sessions.get(chatId);
}

function clear(chatId) {
  sessions.delete(chatId);
}

function currentQuestion(session) {
  if (!session) return null;
  if (session.cursor >= session.questions.length) return null;
  return session.questions[session.cursor];
}

function formatPrompt(session) {
  const q = currentQuestion(session);
  if (!q) return null;
  const idx = session.cursor + 1;
  const total = session.questions.length;
  const options = (q.options || [])
    .map((opt, i) => `${i + 1} = ${opt}`)
    .join("\n");
  return (
    `Catalogue clarification ${idx}/${total}\n\n` +
    `${q.question}\n\n` +
    `${options}\n\n` +
    `Reply with the number (1, 2, …) or type "skip" to apply best-inference for this one.`
  );
}

function parseReply(text) {
  const t = String(text || "").trim().toLowerCase();
  if (t === "skip") return { skip: true };
  const n = parseInt(t, 10);
  if (Number.isFinite(n) && n >= 1) return { choice: n };
  return null;
}

/**
 * Apply the reply to the current question. Advances the cursor.
 * Returns { done: boolean } — done=true when all questions answered.
 */
function applyReply(session, reply) {
  const q = currentQuestion(session);
  if (!q) return { done: true };
  if (reply.skip) {
    session.answers[session.cursor] = null; // use best-inference
  } else if (reply.choice) {
    const opt = (q.options || [])[reply.choice - 1];
    session.answers[session.cursor] = opt ?? null;
  }
  session.cursor += 1;
  return { done: session.cursor >= session.questions.length };
}

module.exports = {
  start,
  get,
  clear,
  currentQuestion,
  formatPrompt,
  parseReply,
  applyReply,
};
