// src/github.js
// Thin helpers over the GitHub REST API for the APS transcript ingestion flow.
// Uses the Contents API (PUT/GET /repos/:owner/:repo/contents/:path) for writes
// and the Tree API for cheap directory listings.
//
// Required env:
//   GITHUB_TOKEN  — PAT with repo:contents:write scope to the aps-master repo
//   GITHUB_REPO   — "owner/repo" (e.g., "joshuaboike/aps-master")
//   GITHUB_BRANCH — optional; defaults to "main"
//   GITHUB_COMMIT_AUTHOR_NAME  — optional; default "clickup-bot"
//   GITHUB_COMMIT_AUTHOR_EMAIL — optional; default "clickup-bot@ddc.local"

const axios = require("axios");
const { formatAxiosError } = require("./httpErrors");

const API = "https://api.github.com";

function config() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!token || !repo) {
    throw new Error(
      "GitHub ingestion requires GITHUB_TOKEN and GITHUB_REPO env vars"
    );
  }
  return { token, repo, branch };
}

function headers() {
  const { token } = config();
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function authorBlock() {
  return {
    name: process.env.GITHUB_COMMIT_AUTHOR_NAME || "clickup-bot",
    email: process.env.GITHUB_COMMIT_AUTHOR_EMAIL || "clickup-bot@ddc.local",
  };
}

function encodeBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Get file contents + current sha if it exists (needed for updates).
 * Returns { exists: boolean, sha?: string, content?: string }
 */
async function getFile(path) {
  const { repo, branch } = config();
  try {
    const res = await axios.get(
      `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
      { params: { ref: branch }, headers: headers() }
    );
    const decoded =
      res.data.encoding === "base64"
        ? Buffer.from(res.data.content, "base64").toString("utf8")
        : res.data.content;
    return { exists: true, sha: res.data.sha, content: decoded };
  } catch (err) {
    if (err.response?.status === 404) return { exists: false };
    throw new Error(formatAxiosError(err, "GitHub getFile"));
  }
}

/**
 * Create or update a file in the repo. Auto-detects existing sha.
 * @returns { url: html_url of the file, commit: sha, updated: bool }
 */
async function putFile(path, content, commitMessage) {
  const { repo, branch } = config();
  const existing = await getFile(path);
  const body = {
    message: commitMessage,
    content: encodeBase64(content),
    branch,
    author: authorBlock(),
    committer: authorBlock(),
  };
  if (existing.exists) body.sha = existing.sha;

  try {
    const res = await axios.put(
      `${API}/repos/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
      body,
      { headers: headers() }
    );
    return {
      url: res.data.content?.html_url,
      commit: res.data.commit?.sha,
      updated: existing.exists,
    };
  } catch (err) {
    throw new Error(formatAxiosError(err, "GitHub putFile"));
  }
}

/**
 * Fetch the repo tree recursively and return paths matching a prefix + extension.
 * Used to discover entity IDs without reading every file.
 */
async function listTree(prefix = "", suffix = "") {
  const { repo, branch } = config();
  try {
    const res = await axios.get(
      `${API}/repos/${repo}/git/trees/${branch}`,
      { params: { recursive: 1 }, headers: headers() }
    );
    const all = (res.data.tree || []).filter((n) => n.type === "blob");
    return all
      .map((n) => n.path)
      .filter((p) => (!prefix || p.startsWith(prefix)) && (!suffix || p.endsWith(suffix)));
  } catch (err) {
    throw new Error(formatAxiosError(err, "GitHub listTree"));
  }
}

/**
 * Fetch and parse the entity-index.json that brain.py render emits.
 * Falls back to deriving IDs from the tree if the index doesn't exist yet.
 */
async function fetchEntityIndex() {
  // Preferred: single JSON file with id + aliases + type + one-line context
  const byIndex = await getFile("views/entity-index.json");
  if (byIndex.exists) {
    try {
      return { source: "json", entities: JSON.parse(byIndex.content) };
    } catch {
      /* fall through to tree derivation */
    }
  }
  // Fallback: derive bare IDs from tree
  const paths = await listTree("entities/", ".md");
  const entities = paths.map((p) => {
    const parts = p.split("/");
    return {
      id: parts[parts.length - 1].replace(/\.md$/, ""),
      type: parts[1] || "unknown",
      aliases: [],
      context: null,
    };
  });
  return { source: "tree-fallback", entities };
}

module.exports = {
  getFile,
  putFile,
  listTree,
  fetchEntityIndex,
  config,
};
