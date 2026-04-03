// In-memory transcript collector for meetings pasted across several Telegram messages.

/** @type {Map<string, { spaceName: string, dateStr: string, itemName: string, parts: string[], updatedAt: number }>} */
const buffers = new Map();

const TTL_MS = 45 * 60 * 1000;

function key(chatId) {
  return String(chatId);
}

function prune() {
  const now = Date.now();
  for (const [k, v] of buffers) {
    if (now - v.updatedAt > TTL_MS) buffers.delete(k);
  }
}

function get(chatId) {
  prune();
  return buffers.get(key(chatId)) || null;
}

function start(chatId, spaceName, dateStr, itemName) {
  const k = key(chatId);
  buffers.set(k, {
    spaceName,
    dateStr,
    itemName,
    parts: [],
    updatedAt: Date.now(),
  });
}

function append(chatId, text) {
  const b = buffers.get(key(chatId));
  if (!b) return false;
  b.parts.push(text);
  b.updatedAt = Date.now();
  return true;
}

function take(chatId) {
  const k = key(chatId);
  const b = buffers.get(k);
  buffers.delete(k);
  return b;
}

function cancel(chatId) {
  buffers.delete(key(chatId));
}

module.exports = {
  get,
  start,
  append,
  take,
  cancel,
};
