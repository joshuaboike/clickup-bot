// In-memory transcript collector for meetings pasted across several Telegram messages.
// /done uses a short debounce so Telegram can deliver split-paste chunks that arrive after /done.

/** @type {Map<string, object>} */
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

function clearFlushTimer(b) {
  if (b.flushTimer) {
    clearTimeout(b.flushTimer);
    b.flushTimer = null;
  }
}

function armFlushTimer(chatId, b, delayMs, runFlush) {
  clearFlushTimer(b);
  b.flushTimer = setTimeout(() => runFlush(chatId), delayMs);
}

function runFlush(chatId) {
  const k = key(chatId);
  const b = buffers.get(k);
  if (!b || !b.debounceFlush || !b.onDoneFlush) return;
  const cb = b.onDoneFlush;
  clearFlushTimer(b);
  const payload = {
    spaceName: b.spaceName,
    dateStr: b.dateStr,
    itemName: b.itemName,
    parts: b.parts.slice(),
  };
  buffers.delete(k);
  cb(payload);
}

/**
 * First /done: schedule flush after delayMs (resets on each append while waiting).
 * Second /done while waiting: flush immediately.
 * @returns {{ ok: true, scheduled?: boolean, immediate?: boolean } | { ok: false, code: string }}
 */
function requestDone(chatId, delayMs, onFlush) {
  const b = buffers.get(key(chatId));
  if (!b) return { ok: false, code: "no_buffer" };

  if (b.debounceFlush) {
    clearFlushTimer(b);
    b.debounceFlush = false;
    b.onDoneFlush = null;
    const payload = {
      spaceName: b.spaceName,
      dateStr: b.dateStr,
      itemName: b.itemName,
      parts: b.parts.slice(),
    };
    buffers.delete(key(chatId));
    onFlush(payload);
    return { ok: true, immediate: true };
  }

  b.debounceFlush = true;
  b.onDoneFlush = onFlush;
  b.flushDelayMs = delayMs;
  armFlushTimer(chatId, b, delayMs, runFlush);
  return { ok: true, scheduled: true };
}

function append(chatId, text) {
  const b = buffers.get(key(chatId));
  if (!b) return false;
  b.parts.push(text);
  b.updatedAt = Date.now();
  if (b.debounceFlush && b.flushDelayMs != null) {
    armFlushTimer(chatId, b, b.flushDelayMs, runFlush);
  }
  return true;
}

function take(chatId) {
  const k = key(chatId);
  const b = buffers.get(k);
  if (b) clearFlushTimer(b);
  buffers.delete(k);
  return b;
}

function cancel(chatId) {
  const k = key(chatId);
  const b = buffers.get(k);
  if (b) clearFlushTimer(b);
  buffers.delete(k);
}

module.exports = {
  get,
  start,
  append,
  take,
  cancel,
  requestDone,
};
