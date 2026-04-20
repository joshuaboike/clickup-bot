// scripts/dump-to-aps-master.js
// One-time backfill: pull every ClickUp doc under the APS folder and write to
// /Users/MacBook/Documents/APS/aps-master/{transcripts,docs}/ with frontmatter.
//
// Usage:
//   node scripts/dump-to-aps-master.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const {
  findSpaceByName,
  listAllDocsForLocation,
  getDocMarkdownById,
} = require("../src/clickup");

const APS_MASTER = "/Users/MacBook/Documents/APS/aps-master";
const TRANSCRIPTS_DIR = path.join(APS_MASTER, "transcripts");
const DOCS_DIR = path.join(APS_MASTER, "docs");

// Parse dates from ClickUp doc titles.
// Handles: "3.23.26", "04.01.2026", "04.02.26_...", "3.25.25", etc.
// Returns { iso, rest } where rest is the title with the date chunk removed, or null.
function parseDateFromTitle(title) {
  // M(M).D(D).YY(YY) optionally followed by separator (space, _, -) and rest.
  // Can't use \b here — regex word-boundary treats `_` as word char, which breaks "26_..."
  const m = title.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:[\s_\-]+(.*))?$/);
  if (m && m[4] === undefined) m[4] = "";
  if (!m) return null;
  const mo = Number(m[1]);
  const d = Number(m[2]);
  let y = Number(m[3]);
  if (y < 100) y = 2000 + y;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y.toString().padStart(4, "0")}-${mo
    .toString()
    .padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
  return { iso, rest: m[4].trim() };
}

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/w\//g, "w-")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 80) || "untitled";
}

function yamlEscape(s) {
  if (s == null) return '""';
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildFrontmatter({ id, type, date, clickupId, clickupUrl, title }) {
  const lines = [
    "---",
    `id: ${id}`,
    `type: ${type}`,
  ];
  if (date) lines.push(`date: ${date}`);
  lines.push(
    `source: clickup`,
    `clickup_id: ${yamlEscape(clickupId)}`,
    `clickup_url: ${yamlEscape(clickupUrl)}`,
    `title: ${yamlEscape(title)}`,
    `attendees: []`,
    `people: []`,
    `workstreams: []`,
    `systems: []`,
    `related_docs: []`,
    `commitments: []`,
    "---",
    "",
  );
  return lines.join("\n");
}

function clickupDocUrl(teamId, docId) {
  return `https://app.clickup.com/${teamId}/docs/${docId}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

(async () => {
  const teamId = process.env.CLICKUP_TEAM_ID;
  if (!teamId) {
    console.error("CLICKUP_TEAM_ID missing from .env");
    process.exit(1);
  }

  console.log("Resolving APS location...");
  const location = await findSpaceByName("APS");
  console.log(`  → ${location.type} id=${location.id}\n`);

  console.log("Listing all docs under APS...");
  const docs = await listAllDocsForLocation(location);
  console.log(`  → ${docs.length} docs found\n`);

  ensureDir(TRANSCRIPTS_DIR);
  ensureDir(DOCS_DIR);

  let transcriptCount = 0;
  let docCount = 0;
  let skipCount = 0;
  const warnings = [];

  for (const doc of docs) {
    if (doc.deleted) {
      skipCount += 1;
      continue;
    }

    const title = doc.name || "untitled";
    console.log(`• ${title}`);

    let markdown;
    try {
      markdown = await getDocMarkdownById(doc.id);
    } catch (err) {
      warnings.push(`FAILED fetch: ${title} — ${err.message}`);
      console.log(`    ⚠ fetch failed: ${err.message}`);
      continue;
    }

    if (!markdown || !markdown.trim()) {
      warnings.push(`EMPTY body: ${title}`);
      console.log(`    ⚠ empty body`);
    }

    const parsed = parseDateFromTitle(title);
    const url = clickupDocUrl(teamId, doc.id);

    if (parsed) {
      const slug = slugify(parsed.rest || title);
      const id = `${parsed.iso}-${slug}`;
      const filename = `${id}.md`;
      const filepath = path.join(TRANSCRIPTS_DIR, filename);

      const fm = buildFrontmatter({
        id,
        type: "transcript",
        date: parsed.iso,
        clickupId: doc.id,
        clickupUrl: url,
        title,
      });

      fs.writeFileSync(filepath, fm + (markdown || "") + "\n");
      transcriptCount += 1;
      console.log(`    → transcripts/${filename}`);
    } else {
      const slug = slugify(title);
      const filename = `${slug}.md`;
      const filepath = path.join(DOCS_DIR, filename);

      const fm = buildFrontmatter({
        id: slug,
        type: "doc",
        date: null,
        clickupId: doc.id,
        clickupUrl: url,
        title,
      });

      fs.writeFileSync(filepath, fm + (markdown || "") + "\n");
      docCount += 1;
      console.log(`    → docs/${filename}  (no date in title)`);
    }
  }

  console.log("\n─── Summary ───");
  console.log(`  transcripts written: ${transcriptCount}`);
  console.log(`  docs written:        ${docCount}`);
  console.log(`  skipped (deleted):   ${skipCount}`);
  if (warnings.length) {
    console.log(`\n  Warnings (${warnings.length}):`);
    for (const w of warnings) console.log(`    • ${w}`);
  }
})().catch((err) => {
  console.error("\nFATAL:", err.message);
  if (err.response?.data) {
    console.error(JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
