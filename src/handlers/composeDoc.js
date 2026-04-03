// /compose — pick a source ClickUp doc by intent, then create a new doc (Claude)

const clickup = require("../clickup");
const claude = require("../claude");
const { sendMessage, sendMessageChunks } = require("../telegram");

function composeMaxCandidates() {
  const n = parseInt(process.env.COMPOSE_MAX_CANDIDATES, 10);
  if (Number.isFinite(n) && n >= 10) return Math.min(n, 200);
  return 80;
}

/**
 * @returns {object|null} null if not a compose command
 */
function parseComposeCommand(text) {
  const t = text.trim();
  if (!/^\/compose(\s|$)/i.test(t)) return null;

  const rest = t.replace(/^\/compose\s*/i, "").trim();
  if (!rest) return { error: "usage" };

  const allMatch = rest.match(/^all\s+(.+)$/is);
  if (allMatch) {
    const q = allMatch[1].trim();
    if (!q) return { error: "usage" };
    return { scope: "all", instruction: q };
  }
  if (/^all$/i.test(rest)) return { error: "need_instruction_after_all" };

  const dq = rest.match(/^"([^"]+)"\s+(.+)$/is);
  if (dq) {
    return {
      scope: "location",
      location: dq[1].trim(),
      instruction: dq[2].trim(),
    };
  }
  const sq = rest.match(/^'([^']+)'\s+(.+)$/is);
  if (sq) {
    return {
      scope: "location",
      location: sq[1].trim(),
      instruction: sq[2].trim(),
    };
  }

  const uw = rest.match(/^(\S+)\s+(.+)$/is);
  if (uw) {
    return {
      scope: "location",
      location: uw[1],
      instruction: uw[2].trim(),
    };
  }

  return { error: "usage" };
}

function docUpdatedMs(d) {
  const v = d.date_updated || d.date_edited || d.updated_at || d.created_at || 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function slimCandidates(rawDocs, max) {
  const list = (rawDocs || [])
    .filter((d) => d && !d.deleted && d.id && d.name)
    .map((d) => ({
      id: String(d.id),
      name: String(d.name),
      updated: docUpdatedMs(d),
    }))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, max);

  return list;
}

function fallbackPickCandidate(candidates, instruction) {
  if (!candidates.length) return null;
  const words = instruction
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const n = c.name.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (n.includes(w)) score += 2;
    }
    const dates = instruction.match(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g) || [];
    for (const dt of dates) {
      if (n.includes(dt.replace(/\//g, ".")) || n.includes(dt)) score += 3;
    }
    const tie = score - bestScore;
    if (tie > 0 || (tie === 0 && c.updated > best.updated)) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

async function handleComposeCommand(parsed) {
  if (parsed.error === "need_instruction_after_all") {
    await sendMessage(
      "Add instructions after `all`, e.g. `/compose all Draft a weekly summary from the latest client notes`",
      "Markdown"
    );
    return;
  }
  if (parsed.error) {
    await sendMessage(
      `*Compose* — new ClickUp doc from an existing one (AI picks the source)\n\n` +
        `*Whole workspace* (slower, many docs):\n` +
        `\`/compose all Write a proposal based on the latest Catalant call notes\`\n\n` +
        `*Scoped to one space / folder / list:*\n` +
        `\`/compose SolisRx Generate a proposal from the 04.02.26 Catalant call doc\`\n` +
        `\`/compose "Snak King" Summarize last week’s meeting doc\`\n\n` +
        `You can start with \`Compose \` instead of \`/compose \`.\n` +
        `_The bot lists docs in that scope, Claude picks the best match, then writes the new doc in the same area._`,
      "Markdown"
    );
    return;
  }

  const { instruction, scope, location } = parsed;
  await sendMessage("⏳ Finding docs, choosing the best source, then drafting…", null);

  let fallbackParent = null;
  let rawDocs;
  let scopeLabel;

  try {
    if (scope === "all") {
      rawDocs = await clickup.listAllDocsInWorkspace();
      scopeLabel = "entire workspace";
      const spaces = await clickup.getSpaces();
      if (!spaces.length) {
        await sendMessage("No spaces in workspace.", null);
        return;
      }
      fallbackParent = { id: String(spaces[0].id), type: "space" };
    } else {
      fallbackParent = await clickup.findSpaceByName(location);
      rawDocs = await clickup.listAllDocsForLocation(fallbackParent);
      scopeLabel = `"${location}" (${fallbackParent.type})`;
    }
  } catch (err) {
    await sendMessage(`❌ ${err.message || err}`, null);
    return;
  }

  const maxCand = composeMaxCandidates();
  const candidates = slimCandidates(rawDocs, maxCand);
  if (candidates.length === 0) {
    await sendMessage(
      `No ClickUp docs found in scope (${scopeLabel}). Create or move a doc there first.`,
      null
    );
    return;
  }

  const forModel = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    updated: c.updated ? new Date(c.updated).toISOString() : "",
  }));

  let chosenId;
  let chosenName;
  let pickHow = "model";

  try {
    const pick = await claude.pickSourceDocForCompose({
      userRequest: instruction,
      candidates: forModel,
    });
    const id = pick.chosenDocId != null ? String(pick.chosenDocId).trim() : "";
    const valid = candidates.some((c) => c.id === id);
    if (valid) {
      chosenId = id;
      chosenName = pick.chosenName || candidates.find((c) => c.id === id)?.name;
    }
  } catch (err) {
    console.warn("pickSourceDocForCompose:", err.message);
  }

  if (!chosenId) {
    const fb = fallbackPickCandidate(candidates, instruction);
    if (fb) {
      chosenId = fb.id;
      chosenName = fb.name;
      pickHow = "keyword/recency fallback";
    }
  }

  if (!chosenId) {
    await sendMessage(
      `Could not pick a source doc among ${candidates.length} in ${scopeLabel}. Try a more specific instruction or narrow scope (e.g. a folder name).`,
      null
    );
    return;
  }

  let sourceMarkdown;
  try {
    sourceMarkdown = await clickup.getDocMarkdownById(chosenId);
  } catch (err) {
    await sendMessage(`❌ Could not read source doc: ${err.message}`, null);
    return;
  }

  if (!sourceMarkdown || sourceMarkdown.length < 20) {
    await sendMessage(
      `Source doc "${chosenName || chosenId}" has almost no text to work from. Pick another doc or add content in ClickUp.`,
      null
    );
    return;
  }

  let composed;
  try {
    composed = await claude.composeNewClickUpDoc({
      userRequest: instruction,
      sourceName: chosenName || chosenId,
      sourceMarkdown,
    });
  } catch (err) {
    await sendMessage(`❌ Compose failed: ${err.message}`, null);
    return;
  }

  const newTitle =
    (composed.newTitle && String(composed.newTitle).trim()) || "Composed document";
  const body =
    (composed.body && String(composed.body).trim()) ||
    "_(empty body — check model response)_";

  const sourceRow = rawDocs.find((d) => String(d.id) === chosenId);
  const fromList = clickup.locationFromDocParent(sourceRow?.parent);
  let fromApi = null;
  try {
    fromApi = await clickup.getDocParentLocation(chosenId);
  } catch {
    fromApi = null;
  }
  const createParent = fromList || fromApi || fallbackParent;
  if (!createParent) {
    await sendMessage("Could not determine where to create the new doc.", null);
    return;
  }

  let created;
  try {
    created = await clickup.createDoc(createParent, newTitle, body);
  } catch (err) {
    await sendMessage(`❌ Could not create ClickUp doc: ${err.message}`, null);
    return;
  }

  // Plain text only — Telegram "Markdown" often 400s on titles with *, _, [], or long URLs.
  const srcLine = String(chosenName || chosenId).replace(/[\n\r]+/g, " ");
  const note =
    `✅ New doc created\n\n` +
    `${newTitle}\n` +
    `${created.url}\n\n` +
    `Source: ${srcLine}\n` +
    `Picked: ${pickHow}\n` +
    `Scope: ${scopeLabel}`;

  let sent = await sendMessage(note, null);
  if (!sent) {
    const minimal = `✅ New doc: ${created.url}`;
    sent = await sendMessage(minimal, null);
  }
  if (!sent) {
    console.error("compose: failed to send Telegram success for doc", created.id);
  }
}

module.exports = { parseComposeCommand, handleComposeCommand };
