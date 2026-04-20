// src/claude.js
// Calls Anthropic's API to analyze meeting transcripts and extract structured todos.

const axios = require("axios");
const { formatAxiosError } = require("./httpErrors");

/**
 * Messages API model for all Claude calls in this bot.
 * Default is the strongest generally available model; override with ANTHROPIC_MODEL if your key/plan requires it.
 */
function anthropicModel() {
  return process.env.ANTHROPIC_MODEL || "claude-opus-4-6";
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MAX_RETRIES = parseInt(process.env.ANTHROPIC_MAX_RETRIES, 10) || 5;
const ANTHROPIC_BASE_DELAY_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryableAnthropicError(err) {
  if (!err.response) {
    // Network / timeout / connection reset — retry.
    const code = err.code;
    return (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "ECONNABORTED" ||
      code === "EAI_AGAIN" ||
      code === "ENOTFOUND"
    );
  }
  const status = err.response.status;
  // 429 rate-limited, 529 overloaded, 500/502/503/504 transient server errors.
  return status === 429 || status === 529 || (status >= 500 && status <= 599);
}

/**
 * POST to Anthropic Messages API with exponential backoff on 429/529/5xx
 * and transient network errors. Honors `retry-after` header when present.
 */
async function anthropicPost(body) {
  const headers = {
    "x-api-key": process.env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  let lastErr;
  for (let attempt = 0; attempt <= ANTHROPIC_MAX_RETRIES; attempt++) {
    try {
      return await axios.post(ANTHROPIC_URL, body, { headers });
    } catch (err) {
      lastErr = err;
      if (attempt === ANTHROPIC_MAX_RETRIES || !isRetryableAnthropicError(err)) {
        throw err;
      }

      // Prefer server-suggested delay if present.
      let waitMs;
      const retryAfter = err.response?.headers?.["retry-after"];
      if (retryAfter) {
        const asNum = Number(retryAfter);
        waitMs = Number.isFinite(asNum)
          ? asNum * 1000
          : Math.max(0, new Date(retryAfter).getTime() - Date.now());
      }
      if (!waitMs || !Number.isFinite(waitMs) || waitMs <= 0) {
        // Exponential backoff with jitter: 1s, 2s, 4s, 8s, 16s (+/- 25%).
        const base = ANTHROPIC_BASE_DELAY_MS * 2 ** attempt;
        const jitter = base * (Math.random() * 0.5 - 0.25);
        waitMs = Math.min(30_000, Math.round(base + jitter));
      }

      const status = err.response?.status || err.code || "network";
      console.warn(
        `[anthropic] ${status} on attempt ${attempt + 1}/${ANTHROPIC_MAX_RETRIES + 1}, retrying in ${waitMs}ms`
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

/**
 * Very long bodies can still hit HTTP/proxy limits; cap analysis input only.
 * Full transcript is always stored in the ClickUp doc. Override via .env.
 */
function maxTranscriptCharsForAnalysis() {
  const n = parseInt(process.env.ANTHROPIC_MAX_TRANSCRIPT_CHARS, 10);
  if (Number.isFinite(n) && n > 10_000) return n;
  return 400_000;
}

/**
 * Analyzes a meeting transcript.
 * Returns { summary: string, todos: [{ person: string, task: string }] }
 *
 * The prompt instructs Claude to return ONLY valid JSON — no markdown fences,
 * no preamble — so we can parse it directly.
 */
async function analyzeMeeting(transcript) {
  const cap = maxTranscriptCharsForAnalysis();
  let textForClaude = transcript;
  if (textForClaude.length > cap) {
    textForClaude =
      textForClaude.slice(0, cap) +
      "\n\n[Transcript truncated here for analysis only — the full recording is saved in ClickUp.]";
  }

  let response;
  try {
    response = await anthropicPost(
      {
        model: anthropicModel(),
        max_tokens: 8192,
        system: `You are a meeting analyst. When given a transcript, you extract all materially noteworthy information and action items.

You MUST respond with ONLY a valid JSON object — no markdown backticks, no preamble, no explanation. Just raw JSON.

The JSON structure must be exactly:
{
  "summary": "A concise but complete summary of key discussion points, decisions, and context. Use markdown formatting with ## headers grouped by topic.",
  "todos": [
    { "person": "First name only", "task": "Clear, actionable task description" }
  ]
}

Rules for todos:
- List EVERY action item, commitment, or follow-up mentioned
- Use first name only for person (e.g. "Josh", "Jen", "Mark")
- If a todo is unclear who owns it, assign to "Josh"
- Tasks should be specific and actionable`,
        messages: [
          {
            role: "user",
            content: `Please analyze this meeting transcript and extract all key information and action items:\n\n${textForClaude}`,
          },
        ],
      }
    );
  } catch (err) {
    throw new Error(formatAxiosError(err, "Anthropic Claude"));
  }

  const block = response.data?.content?.[0];
  if (!block || block.type !== "text" || !block.text) {
    throw new Error(
      `Anthropic Claude: unexpected response (no text block): ${JSON.stringify(response.data)}`
    );
  }

  const raw = block.text.trim();

  // Strip markdown code fences if Claude includes them despite instructions
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Failed to parse Claude response as JSON:", cleaned);
    return {
      summary: cleaned,
      todos: [],
    };
  }
}

/**
 * Compare existing open tasks vs new task candidates and return likely duplicate pairs.
 * Returns array of { existingIndex: number, newIndex: number, reason: string, confidence: number }
 */
async function findPotentialTaskDuplicates(existingTasks, newTasks) {
  if (!existingTasks.length || !newTasks.length) return [];

  let response;
  try {
    response = await anthropicPost(
      {
        model: anthropicModel(),
        max_tokens: 4000,
        system: `You detect likely duplicate work items.

Return ONLY valid JSON with this exact shape:
{
  "pairs": [
    {
      "existingIndex": 0,
      "newIndex": 0,
      "reason": "short why",
      "confidence": 0.0
    }
  ]
}

Rules:
- existingIndex must reference the existing array.
- newIndex must reference the new array.
- confidence must be from 0.0 to 1.0.
- Only include likely duplicates (semantic meaning overlap, not just wording).
- Keep at most one pair per newIndex (best match only).
- If none, return {"pairs":[]}.`,
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                existing: existingTasks.map((name, i) => ({ index: i, name })),
                incoming: newTasks.map((name, i) => ({ index: i, name })),
              },
              null,
              2
            ),
          },
        ],
      }
    );
  } catch (err) {
    throw new Error(formatAxiosError(err, "Anthropic duplicate check"));
  }

  const block = response.data?.content?.[0];
  if (!block || block.type !== "text" || !block.text) return [];
  const raw = block.text.trim();
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned);
    const seenNew = new Set();
    const pairs = Array.isArray(parsed.pairs) ? parsed.pairs : [];
    return pairs
      .filter((p) => Number.isInteger(p.existingIndex) && Number.isInteger(p.newIndex))
      .filter((p) => p.existingIndex >= 0 && p.existingIndex < existingTasks.length)
      .filter((p) => p.newIndex >= 0 && p.newIndex < newTasks.length)
      .filter((p) => !seenNew.has(p.newIndex) && seenNew.add(p.newIndex))
      .map((p) => ({
        existingIndex: p.existingIndex,
        newIndex: p.newIndex,
        reason: p.reason || "Likely same outcome",
        confidence:
          typeof p.confidence === "number"
            ? Math.max(0, Math.min(1, p.confidence))
            : 0.5,
      }));
  } catch {
    return [];
  }
}

/**
 * Rank open tasks for “what to do today” using age, priority, and semantics.
 * @param {object} payload - { tasks: [...], assigneeNote: string, dateLabel: string }
 */
async function prioritizeTodayFocus(payload) {
  let response;
  try {
    response = await anthropicPost(
      {
        model: anthropicModel(),
        max_tokens: 6000,
        system: `You help an operator decide what to focus on TODAY across many client workspaces.

You MUST respond with ONLY valid JSON — no markdown fences, no preamble. Raw JSON only.

Shape:
{
  "summary": "2–4 sentences: your honest read of the day, tradeoffs, anything urgent or stale.",
  "doFirst": [
    { "refIndex": 0, "why": "1–2 sentences" }
  ],
  "ifTime": [
    { "refIndex": 0, "why": "short" }
  ],
  "deferOrPark": [
    { "refIndex": 0, "why": "short" }
  ],
  "maybeNotWorthIt": [
    { "refIndex": 0, "why": "optional — tasks that look obsolete or duplicate-looking" }
  ]
}

Rules:
- refIndex MUST be copied exactly from the input tasks[].refIndex. Never invent indices.
- Strongly weight: explicit ClickUp priority, age (daysOpen), blocking commitments, revenue/risk, deadlines implied in titles, “waiting on” patterns.
- You are allowed to disagree with task titles if they look low leverage.
- Keep each section to at most 7 items; omit empty arrays or use [].
- Put the true must-do work in doFirst; offer alternatives in ifTime.
- Be direct and practical.`,
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      }
    );
  } catch (err) {
    throw new Error(formatAxiosError(err, "Anthropic focus"));
  }

  const block = response.data?.content?.[0];
  if (!block || block.type !== "text" || !block.text) {
    throw new Error("Anthropic focus: empty response");
  }
  const raw = block.text.trim();
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      summary: cleaned,
      doFirst: [],
      ifTime: [],
      deferOrPark: [],
      maybeNotWorthIt: [],
    };
  }
}

/**
 * Natural-language answers over a task snapshot (plain text reply).
 */
async function answerAskAboutTasks(payload) {
  let response;
  try {
    response = await anthropicPost(
      {
        model: anthropicModel(),
        max_tokens: 6000,
        system: `You answer practical questions about someone’s open ClickUp work.

Rules:
- Use ONLY the tasks provided in the JSON. Do not invent tasks, dates, or clients.
- If the snapshot is empty or missing data to answer, say so clearly.
- Respect time context (e.g. “end of day”, “this week”) using todayContext and due_date fields (due_date is ms string or null).
- Be concise but specific: name tasks, mention due dates when relevant, and give clear next actions.
- When helpful, end lines with the task URL from the payload (plain URLs, no markdown required).
- If many tasks match, prioritize what best fits the question; you may group by list or theme.`,
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      }
    );
  } catch (err) {
    throw new Error(formatAxiosError(err, "Anthropic /ask"));
  }

  const block = response.data?.content?.[0];
  if (!block || block.type !== "text" || !block.text) {
    throw new Error("Anthropic /ask: empty response");
  }
  return block.text.trim();
}

/**
 * Answer from combined task list + doc excerpts (plain text).
 */
async function answerUnifiedQuery(payload) {
  let response;
  try {
    response = await anthropicPost(
      {
        model: anthropicModel(),
        max_tokens: 12_000,
        system: `You answer questions using ONLY the tasks and doc excerpts in the JSON payload.

Rules:
- Do not invent tasks, docs, dates, or commitments not supported by the excerpts.
- Clearly separate what comes from *tasks* vs *docs* when useful.
- Doc bodies may be truncated — say so if you’re inferring from partial text.
- Quote or paraphrase key facts; cite doc titles and task titles. Plain URLs from the payload are fine.
- If the question can’t be answered from the snapshot, say what’s missing (e.g. older docs not loaded, empty scope).`,
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
      }
    );
  } catch (err) {
    throw new Error(formatAxiosError(err, "Anthropic /query"));
  }

  const block = response.data?.content?.[0];
  if (!block || block.type !== "text" || !block.text) {
    throw new Error("Anthropic /query: empty response");
  }
  return block.text.trim();
}

function maxComposeSourceChars() {
  const n = parseInt(process.env.COMPOSE_MAX_SOURCE_CHARS, 10);
  if (Number.isFinite(n) && n > 20_000) return Math.min(n, 500_000);
  return 120_000;
}

/**
 * Choose which existing ClickUp doc best matches the user’s intent (IDs only from candidates).
 */
async function pickSourceDocForCompose({ userRequest, candidates }) {
  let response;
  try {
    response = await anthropicPost(
      {
        model: anthropicModel(),
        max_tokens: 2000,
        system: `You pick ONE existing document that best matches the user’s intent for “use this as source material”.

Respond with ONLY valid JSON, no markdown fences:
{
  "chosenDocId": "exact id string from candidates or null",
  "chosenName": "doc name or null",
  "rationale": "1-2 sentences"
}

Rules:
- chosenDocId MUST equal one of the provided candidate ids exactly, or null if none fit.
- Prefer docs whose names or dates plausibly relate to meetings, calls, clients, or keywords in the request.
- When unsure, pick the single best guess; use null only if candidates are clearly irrelevant.`,
        messages: [
          {
            role: "user",
            content: JSON.stringify({ userRequest, candidates }),
          },
        ],
      }
    );
  } catch (err) {
    throw new Error(formatAxiosError(err, "Anthropic pick source doc"));
  }

  const block = response.data?.content?.[0];
  if (!block?.text) throw new Error("Anthropic pick source doc: empty response");
  const cleaned = block.text
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { chosenDocId: null, chosenName: null, rationale: cleaned };
  }
}

/**
 * Write a new ClickUp doc body from source markdown + user instructions.
 */
async function composeNewClickUpDoc({ userRequest, sourceName, sourceMarkdown }) {
  const cap = maxComposeSourceChars();
  let md = sourceMarkdown;
  if (md.length > cap) {
    md =
      md.slice(0, cap) +
      "\n\n[…source truncated for model context…]";
  }

  let response;
  try {
    response = await anthropicPost(
      {
        model: anthropicModel(),
        max_tokens: 16_384,
        system: `You create a new document for a client/work context.

Respond with ONLY valid JSON, no markdown fences:
{
  "newTitle": "Short title for the new ClickUp doc",
  "body": "Full markdown body for the new doc"
}

Rules:
- Follow the user’s instructions (e.g. proposal, summary, follow-up email outline).
- Use the source material as factual grounding; do not invent meetings or commitments not supported by the source. If the source is thin, say what’s missing.
- Professional, clear structure (headings, bullets where useful).
- Do not include ClickUp-internal IDs in the prose unless the user asked.`,
        messages: [
          {
            role: "user",
            content: JSON.stringify({
              userRequest,
              sourceDocName: sourceName,
              sourceMarkdown: md,
            }),
          },
        ],
      }
    );
  } catch (err) {
    throw new Error(formatAxiosError(err, "Anthropic compose doc"));
  }

  const block = response.data?.content?.[0];
  if (!block?.text) throw new Error("Anthropic compose doc: empty response");
  const cleaned = block.text
    .trim()
    .replace(/^```json\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return {
      newTitle: "Composed document",
      body: cleaned,
    };
  }
}

/**
 * Catalogue an APS meeting transcript against the existing entity graph.
 * Extracts structured frontmatter fields (attendees, people, workstreams, systems,
 * commitments, related_docs) using the canonical IDs from the entity index.
 *
 * @param {string} transcript — raw transcript body
 * @param {Array} entities — [{id, type, aliases: [], context: string|null}]
 * @returns Object with:
 *   attendees, people, workstreams, systems, commitments, related_docs,
 *   new_entities: {people:[], systems:[]},
 *   clarifications_needed: [{question, options}],
 *   summary: short one-line
 */
async function catalogueTranscript(transcript, entities) {
  const cap = maxTranscriptCharsForAnalysis();
  let body = transcript.length > cap
    ? transcript.slice(0, cap) + "\n\n[Transcript truncated for cataloguing.]"
    : transcript;

  // Group entities by type for a compact prompt
  const byType = { person: [], workstream: [], system: [], glossary: [] };
  for (const e of entities || []) {
    const bucket = byType[e.type] || byType.person;
    const aliasSuffix = (e.aliases && e.aliases.length)
      ? ` (aka ${e.aliases.slice(0, 4).join(", ")})`
      : "";
    bucket.push(`- ${e.id}${aliasSuffix}`);
  }

  const system = `You catalogue APS meeting transcripts for a structured knowledge system (aps-master repo).

Your job: extract frontmatter fields using CANONICAL ENTITY IDs below. Output raw JSON only — no preamble, no markdown fences, no prose.

# Known entity IDs (use these exact ids when matching)

## People
${byType.person.slice(0, 200).join("\n") || "- (none yet)"}

## Workstreams
${byType.workstream.join("\n") || "- (none yet)"}

## Systems
${byType.system.join("\n") || "- (none yet)"}

# Rules

1. \`attendees\` = people EXPLICITLY NAMED AS PRESENT in the transcript body. Do not infer from role or workstream overlap.
2. \`people\` = anyone mentioned anywhere (superset of attendees).
3. When a name matches a canonical ID, use that exact ID (kebab-case). If the transcript uses a variant (e.g., "Jack" for "jak-myers", "Cheyenne" for "xiaoyan-weng"), map to the canonical ID.
4. If a person/system is clearly NEW (not in the list and not a known alias), add to new_entities with a short context note. Use kebab-case for proposed IDs.
5. Workstreams + systems: only include if the transcript directly discusses them.
6. commitments: extract liberally — every "I'll send X", "can you do Y by Friday", "we'll follow up on Z" counts. Each entry: {who: id-or-firstname, what: short action, to: id-or-name optional, due: date or phrase optional}.
7. If two canonical IDs could plausibly match the same mention (50/50 ambiguity), add to clarifications_needed with the options. Do NOT add low-confidence best-inference cases — only genuine ambiguity.
8. summary: one sentence, ≤ 120 chars, for a Telegram reply.

# Output (JSON object, no other text)

{
  "attendees": ["id1", "id2"],
  "people": ["id1", "id2", ...],
  "workstreams": ["ws-id"],
  "systems": ["sys-id"],
  "commitments": [{"who":"id","what":"...","to":"id","due":"..."}],
  "related_docs": [],
  "new_entities": {
    "people": [{"id":"new-person-kebab","context":"one-line"}],
    "systems": []
  },
  "clarifications_needed": [
    {"question":"Dan = dan-hudson or dan-cook?","options":["dan-hudson","dan-cook"]}
  ],
  "summary": "Josh + Jen discussed X; 3 commitments."
}`;

  let response;
  try {
    response = await anthropicPost({
      model: anthropicModel(),
      max_tokens: 4096,
      system,
      messages: [
        {
          role: "user",
          content: `Catalogue this transcript:\n\n${body}`,
        },
      ],
    });
  } catch (err) {
    throw new Error(formatAxiosError(err, "Anthropic Claude (catalogue)"));
  }

  const block = response.data?.content?.[0];
  if (!block || block.type !== "text" || !block.text) {
    throw new Error("Claude catalogue: no text block in response");
  }
  const raw = block.text.trim().replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error("catalogueTranscript: failed to parse JSON:\n", raw);
    throw new Error("Claude returned non-JSON catalogue response");
  }

  // Normalize defensively
  return {
    attendees: Array.isArray(parsed.attendees) ? parsed.attendees : [],
    people: Array.isArray(parsed.people) ? parsed.people : [],
    workstreams: Array.isArray(parsed.workstreams) ? parsed.workstreams : [],
    systems: Array.isArray(parsed.systems) ? parsed.systems : [],
    commitments: Array.isArray(parsed.commitments) ? parsed.commitments : [],
    related_docs: Array.isArray(parsed.related_docs) ? parsed.related_docs : [],
    new_entities: parsed.new_entities && typeof parsed.new_entities === "object"
      ? { people: parsed.new_entities.people || [], systems: parsed.new_entities.systems || [] }
      : { people: [], systems: [] },
    clarifications_needed: Array.isArray(parsed.clarifications_needed)
      ? parsed.clarifications_needed
      : [],
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

module.exports = {
  analyzeMeeting,
  findPotentialTaskDuplicates,
  catalogueTranscript,
  prioritizeTodayFocus,
  answerAskAboutTasks,
  answerUnifiedQuery,
  pickSourceDocForCompose,
  composeNewClickUpDoc,
};
