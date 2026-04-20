// src/apsCatalogue.js
// Orchestrates APS transcript ingestion + cataloguing after the ClickUp flow
// is complete. Called from handlers/meeting.js on spaceName === "APS".
//
// Flow:
//   1. Derive filename from date + title
//   2. Fetch entity-index.json from GitHub (fallback: tree derivation)
//   3. Call Claude catalogueTranscript() to extract frontmatter
//   4. If clarifications_needed → Telegram Q&A (state machine)
//   5. Resolve clarifications → final frontmatter
//   6. Write transcripts/<filename>.md to GitHub via Contents API
//   7. Telegram reply with summary + link

const github = require("./github");
const claude = require("./claude");
const catalogueClarification = require("./catalogueClarification");
const { sendMessage } = require("./telegram");

// ─── Filename derivation ──────────────────────────────────────────────

function parseDate(dateStr) {
  // Accepts "M.D.YY" / "MM.DD.YY" / "MM.DD.YYYY" / "YYYY-MM-DD"
  const s = String(dateStr || "").trim();
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return pad(iso[1], iso[2], iso[3]);
  }
  const dot = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (dot) {
    let y = Number(dot[3]);
    if (y < 100) y = 2000 + y;
    return pad(y, dot[1], dot[2]);
  }
  return null;
}

function pad(y, m, d) {
  return `${String(y).padStart(4, "0")}-${String(Number(m)).padStart(2, "0")}-${String(Number(d)).padStart(2, "0")}`;
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/w\//g, "w-")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80) || "untitled";
}

function deriveFilename(dateStr, title) {
  const iso = parseDate(dateStr);
  if (!iso) throw new Error(`Could not parse date: ${dateStr}`);
  return `${iso}-${slugify(title)}.md`;
}

// ─── Frontmatter rendering ──────────────────────────────────────────────

function yamlScalar(v) {
  if (v == null) return '""';
  const s = String(v);
  if (/[:#&*?{}\[\],|>\n"']/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function yamlList(items) {
  if (!items || items.length === 0) return " []";
  return "\n" + items.map((i) => `  - ${yamlScalar(i)}`).join("\n");
}

function yamlCommitments(items) {
  if (!items || items.length === 0) return " []";
  const lines = [];
  for (const c of items) {
    let first = true;
    for (const key of ["who", "what", "to", "due"]) {
      if (c[key] == null || c[key] === "") continue;
      const prefix = first ? "  - " : "    ";
      lines.push(`${prefix}${key}: ${yamlScalar(c[key])}`);
      first = false;
    }
  }
  return "\n" + lines.join("\n");
}

function buildFrontmatter({ id, date, clickupId, clickupUrl, title, fields, catalogued, ingestedAt }) {
  const lines = [
    "---",
    `id: ${id}`,
    "type: transcript",
    `date: ${date}`,
    "source: clickup",
    `clickup_id: ${yamlScalar(clickupId)}`,
    `clickup_url: ${yamlScalar(clickupUrl)}`,
    `title: ${yamlScalar(title)}`,
    `ingested_at: ${yamlScalar(ingestedAt)}`,
    `catalogued: ${catalogued ? "true" : "false"}`,
    `catalogued_by: auto`,
    `attendees:${yamlList(fields.attendees)}`,
    `people:${yamlList(fields.people)}`,
    `workstreams:${yamlList(fields.workstreams)}`,
    `systems:${yamlList(fields.systems)}`,
    `related_docs:${yamlList(fields.related_docs)}`,
    `commitments:${yamlCommitments(fields.commitments)}`,
    "---",
  ];
  return lines.join("\n") + "\n";
}

// ─── Resolve clarifications ─────────────────────────────────────────────

function applyClarificationAnswers(fields, clarifications, answers) {
  // Best-effort: for each clarification with a chosen answer, try to swap
  // any matching option tokens in attendees/people/workstreams/systems.
  // If answer is null (skip), leave as-is.
  const chosen = clarifications.map((q, i) => ({ q, answer: answers[i] ?? null }));
  for (const { q, answer } of chosen) {
    if (!answer) continue;
    // Remove non-chosen options from the fields lists if they appear
    for (const opt of q.options || []) {
      if (opt === answer) continue;
      for (const key of ["attendees", "people", "workstreams", "systems"]) {
        fields[key] = (fields[key] || []).filter((id) => id !== opt);
      }
    }
    // Ensure chosen option is present in people (and attendees if already in attendees)
    for (const key of ["attendees", "people"]) {
      if (!Array.isArray(fields[key])) continue;
      if (!fields[key].includes(answer)) {
        if (key === "people") fields[key].push(answer);
      }
    }
  }
  return fields;
}

// ─── Write + Telegram reply ─────────────────────────────────────────────

async function writeAndReply({ filename, date, title, clickupId, clickupUrl, transcript, result }) {
  const id = filename.replace(/\.md$/, "");
  const fm = buildFrontmatter({
    id,
    date,
    clickupId: clickupId || null,
    clickupUrl: clickupUrl || null,
    title,
    fields: {
      attendees: result.attendees,
      people: result.people,
      workstreams: result.workstreams,
      systems: result.systems,
      related_docs: result.related_docs,
      commitments: result.commitments,
    },
    catalogued: true,
    ingestedAt: new Date().toISOString(),
  });
  const path = `transcripts/${filename}`;
  const content = fm + "\n" + transcript.trim() + "\n";

  const commitMsg = `Ingest + catalogue APS transcript: ${filename}`;
  const res = await github.putFile(path, content, commitMsg);

  const attendeeNames = (result.attendees || []).slice(0, 4).join(", ") || "(none tagged)";
  const workstreamNames = (result.workstreams || []).slice(0, 4).join(", ") || "—";
  const newEntCount =
    (result.new_entities?.people?.length || 0) + (result.new_entities?.systems?.length || 0);
  const commitCount = (result.commitments || []).length;

  const msg = [
    `📚 APS transcript archived + catalogued.`,
    ``,
    `Attendees: ${attendeeNames}`,
    `Workstreams: ${workstreamNames}`,
    `Commitments: ${commitCount}${newEntCount > 0 ? ` · New entities (low-confidence): ${newEntCount}` : ""}`,
    ``,
    `${res.url || "(no url)"}`,
  ].join("\n");
  await sendMessage(msg, null);
}

// ─── Main orchestrator ──────────────────────────────────────────────────

/**
 * Main entry point. Called AFTER the ClickUp flow is complete.
 * @param {Object} ctx — { dateStr, itemName, transcript, chatId, clickupDocId, clickupDocUrl }
 */
async function runCatalogue(ctx) {
  const { dateStr, itemName, transcript, chatId, clickupDocId, clickupDocUrl } = ctx;
  const filename = deriveFilename(dateStr, itemName);

  // Fetch entity index (graceful fallback if not present)
  let entityIndex;
  try {
    entityIndex = await github.fetchEntityIndex();
  } catch (err) {
    console.warn("apsCatalogue: fetchEntityIndex failed, proceeding with empty list:", err.message);
    entityIndex = { source: "empty", entities: [] };
  }

  // Catalogue via Claude
  let result;
  try {
    result = await claude.catalogueTranscript(transcript, entityIndex.entities);
  } catch (err) {
    await sendMessage(
      `⚠️ APS transcript saved raw (catalogue failed): ${err.message}`,
      null
    );
    // Still save the raw transcript with empty fields
    const emptyResult = {
      attendees: [], people: [], workstreams: [], systems: [],
      commitments: [], related_docs: [],
      new_entities: { people: [], systems: [] }, clarifications_needed: [], summary: "",
    };
    await writeAndReply({
      filename,
      date: parseDate(dateStr),
      title: itemName,
      clickupId: clickupDocId,
      clickupUrl: clickupDocUrl,
      transcript,
      result: emptyResult,
    });
    return;
  }

  // If Claude flagged ambiguities, run Telegram clarification first
  if (result.clarifications_needed && result.clarifications_needed.length > 0 && chatId != null) {
    catalogueClarification.start(chatId, {
      questions: result.clarifications_needed,
      context: {
        filename,
        dateStr,
        itemName,
        transcript,
        clickupDocId,
        clickupDocUrl,
        result,
      },
      onComplete: async (session) => {
        const finalResult = { ...session.context.result };
        applyClarificationAnswers(
          finalResult,
          session.context.result.clarifications_needed,
          session.answers
        );
        await writeAndReply({
          filename: session.context.filename,
          date: parseDate(session.context.dateStr),
          title: session.context.itemName,
          clickupId: session.context.clickupDocId,
          clickupUrl: session.context.clickupDocUrl,
          transcript: session.context.transcript,
          result: finalResult,
        });
      },
    });
    const first = catalogueClarification.formatPrompt(catalogueClarification.get(chatId));
    await sendMessage(
      `I have ${result.clarifications_needed.length} quick clarification(s) before finalizing the APS archive:`,
      null
    );
    if (first) await sendMessage(first, null);
    return;
  }

  // No clarifications → write directly
  await writeAndReply({
    filename,
    date: parseDate(dateStr),
    title: itemName,
    clickupId: clickupDocId,
    clickupUrl: clickupDocUrl,
    transcript,
    result,
  });
}

/**
 * Handle a Telegram reply to an active clarification session.
 * Returns true if the reply was consumed, false if no session was active.
 */
async function handleClarificationReply(chatId, text) {
  const session = catalogueClarification.get(chatId);
  if (!session) return false;
  if (String(text || "").trim().startsWith("/")) return false;

  const reply = catalogueClarification.parseReply(text);
  if (!reply) {
    await sendMessage(
      `I didn't catch that. Reply with a number (1, 2, …) or "skip" to use best-inference for this one.`,
      null
    );
    return true;
  }

  const { done } = catalogueClarification.applyReply(session, reply);
  if (!done) {
    const next = catalogueClarification.formatPrompt(session);
    if (next) await sendMessage(next, null);
    return true;
  }

  // Done — finalize
  try {
    await session.onComplete(session);
  } catch (err) {
    await sendMessage(`⚠️ Finalize step failed: ${err.message}`, null);
  }
  catalogueClarification.clear(chatId);
  return true;
}

function cancelClarification(chatId) {
  if (!catalogueClarification.get(chatId)) return false;
  catalogueClarification.clear(chatId);
  return true;
}

module.exports = {
  runCatalogue,
  handleClarificationReply,
  cancelClarification,
  deriveFilename, // exported for tests
  parseDate,
};
