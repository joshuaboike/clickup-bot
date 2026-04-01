// src/utils.js

/**
 * Returns date formatted as DD.MM.YY
 * e.g. April 1 2026 → "01.04.26"
 */
function formatDate(date) {
  const d = String(date.getDate()).padStart(2, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const y = String(date.getFullYear()).slice(-2);
  return `${d}.${m}.${y}`;
}

module.exports = { formatDate };
