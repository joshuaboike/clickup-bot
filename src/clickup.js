// src/clickup.js
// All ClickUp API interactions. Uses v2 for tasks, v3 for docs.
// Docs: https://clickup.com/api

const axios = require("axios");

const V2 = "https://api.clickup.com/api/v2";
const V3 = "https://api.clickup.com/api/v3";

function headers() {
  return {
    Authorization: process.env.CLICKUP_API_TOKEN,
    "Content-Type": "application/json",
  };
}

// ─── Spaces & Lists ──────────────────────────────────────────────────────────

/**
 * Get all spaces in your team/workspace.
 * Returns array of { id, name }
 */
async function getSpaces() {
  const res = await axios.get(
    `${V2}/team/${process.env.CLICKUP_TEAM_ID}/space?archived=false`,
    { headers: headers() }
  );
  return res.data.spaces;
}

/**
 * Find a space by name (case-insensitive).
 * Returns the space object or throws if not found.
 */
async function findSpaceByName(name) {
  const spaces = await getSpaces();
  const match = spaces.find(
    (s) => s.name.toLowerCase() === name.toLowerCase()
  );
  if (!match) {
    throw new Error(
      `Space "${name}" not found. Available spaces: ${spaces.map((s) => s.name).join(", ")}`
    );
  }
  return match;
}

/**
 * Get all lists in a space (searches folders and root).
 * Returns first list found — adjust if you want to target a specific list.
 */
async function getDefaultListForSpace(spaceId) {
  // Check root-level lists first (no folder)
  const rootRes = await axios.get(`${V2}/space/${spaceId}/list?archived=false`, {
    headers: headers(),
  });
  if (rootRes.data.lists?.length > 0) {
    // Prefer a list named "Task List" if it exists
    const taskList = rootRes.data.lists.find((l) =>
      l.name.toLowerCase().includes("task")
    );
    return taskList || rootRes.data.lists[0];
  }

  // Fall back to first folder's first list
  const foldersRes = await axios.get(
    `${V2}/space/${spaceId}/folder?archived=false`,
    { headers: headers() }
  );
  const folders = foldersRes.data.folders;
  if (folders?.length > 0) {
    const listsRes = await axios.get(
      `${V2}/folder/${folders[0].id}/list?archived=false`,
      { headers: headers() }
    );
    if (listsRes.data.lists?.length > 0) return listsRes.data.lists[0];
  }

  throw new Error(`No lists found in space ${spaceId}`);
}

// ─── Tasks ───────────────────────────────────────────────────────────────────

/**
 * Create a task in a list.
 * @param {string} listId
 * @param {string} name - task title
 * @param {string} description - markdown supported
 * @param {string[]} assigneeIds - ClickUp user IDs to assign
 */
async function createTask(listId, name, description = "", assigneeIds = []) {
  const res = await axios.post(
    `${V2}/list/${listId}/task`,
    {
      name,
      description,
      assignees: assigneeIds,
      status: "to do",
    },
    { headers: headers() }
  );
  return res.data; // { id, url, name, ... }
}

/**
 * Get all open tasks in a space, grouped by list.
 * Returns array of { listName, tasks: [{ id, name, url, assignees }] }
 */
async function getOpenTasksForSpace(spaceId) {
  const res = await axios.get(
    `${V2}/space/${spaceId}/task?archived=false&statuses[]=to do&statuses[]=in progress`,
    { headers: headers() }
  );
  return res.data.tasks || [];
}

// ─── Docs ─────────────────────────────────────────────────────────────────────

/**
 * Create a Doc in a space using ClickUp v3 Docs API.
 * Returns { id, url }
 */
async function createDoc(spaceId, title, content) {
  // Create the doc
  const docRes = await axios.post(
    `${V3}/workspaces/${process.env.CLICKUP_TEAM_ID}/docs`,
    {
      name: title,
      parent: {
        id: spaceId,
        type: 4, // 4 = Space
      },
    },
    { headers: headers() }
  );

  const docId = docRes.data.id;

  // Add content as the first page
  await axios.post(
    `${V3}/workspaces/${process.env.CLICKUP_TEAM_ID}/docs/${docId}/pages`,
    {
      name: title,
      content: content,
      content_format: "text/md", // markdown
    },
    { headers: headers() }
  );

  // Return doc with URL
  return {
    id: docId,
    url: `https://app.clickup.com/${process.env.CLICKUP_TEAM_ID}/docs/${docId}`,
    name: title,
  };
}

// ─── Team Members ─────────────────────────────────────────────────────────────

/**
 * Get all members of your workspace.
 * Useful for debugging user IDs.
 */
async function getTeamMembers() {
  const res = await axios.get(
    `${V2}/team/${process.env.CLICKUP_TEAM_ID}`,
    { headers: headers() }
  );
  return res.data.team.members.map((m) => ({
    id: m.user.id,
    username: m.user.username,
    email: m.user.email,
  }));
}

module.exports = {
  findSpaceByName,
  getDefaultListForSpace,
  createTask,
  getOpenTasksForSpace,
  createDoc,
  getTeamMembers,
};
