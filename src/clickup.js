// src/clickup.js
// All ClickUp API interactions. Uses v2 for tasks, v3 for docs.
// Docs: https://clickup.com/api

const axios = require("axios");
const { formatAxiosError } = require("./httpErrors");

const V2 = "https://api.clickup.com/api/v2";
const V3 = "https://api.clickup.com/api/v3";

function headers() {
  return {
    Authorization: process.env.CLICKUP_API_TOKEN,
    "Content-Type": "application/json",
  };
}

function workspaceIdV3() {
  return Number(process.env.CLICKUP_TEAM_ID);
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

/** Prefer list named "List", then names containing "task", else first list. */
function pickDefaultList(lists) {
  if (!lists?.length) return null;
  const lower = (n) => (n || "").toLowerCase();
  const exactList = lists.find((l) => lower(l.name) === "list");
  if (exactList) return exactList;
  const taskish = lists.find((l) => lower(l.name).includes("task"));
  if (taskish) return taskish;
  return lists[0];
}

/** Nested folders (ClickUp 3+); older workspaces return []. */
async function getSubfolders(folderId) {
  try {
    const res = await axios.get(
      `${V2}/folder/${folderId}/folder?archived=false`,
      { headers: headers() }
    );
    return res.data.folders || [];
  } catch {
    return [];
  }
}

async function forEachFolderInSpace(spaceId, fn) {
  const stack = [];
  const topRes = await axios.get(
    `${V2}/space/${spaceId}/folder?archived=false`,
    { headers: headers() }
  );
  for (const f of topRes.data.folders || []) stack.push(f);

  while (stack.length > 0) {
    const folder = stack.pop();
    await fn(folder);
    const subs = await getSubfolders(folder.id);
    for (const s of subs) stack.push(s);
  }
}

async function findListByNameInWorkspace(normalized, spaces) {
  for (const space of spaces) {
    const rootRes = await axios.get(
      `${V2}/space/${space.id}/list?archived=false`,
      { headers: headers() }
    );
    for (const list of rootRes.data.lists || []) {
      if (list.name.toLowerCase() === normalized) {
        return { id: String(list.id), type: "list" };
      }
    }

    let found = null;
    await forEachFolderInSpace(space.id, async (folder) => {
      if (found) return;
      const listsRes = await axios.get(
        `${V2}/folder/${folder.id}/list?archived=false`,
        { headers: headers() }
      );
      for (const list of listsRes.data.lists || []) {
        if (list.name.toLowerCase() === normalized) {
          found = { id: String(list.id), type: "list" };
          break;
        }
      }
    });
    if (found) return found;
  }
  return null;
}

/**
 * Find space, folder (any depth under a space), or list by name (case-insensitive).
 * Precedence: space → folder → list. First match wins.
 * @returns {{ id: string, type: 'space' | 'folder' | 'list' }}
 */
async function findSpaceByName(name) {
  const normalized = name.trim().toLowerCase();
  const spaces = await getSpaces();

  const spaceMatch = spaces.find((s) => s.name.toLowerCase() === normalized);
  if (spaceMatch) {
    return { id: String(spaceMatch.id), type: "space" };
  }

  for (const space of spaces) {
    let folderMatch = null;
    await forEachFolderInSpace(space.id, async (folder) => {
      if (folderMatch) return;
      if (folder.name.toLowerCase() === normalized) folderMatch = folder;
    });
    if (folderMatch) {
      return { id: String(folderMatch.id), type: "folder" };
    }
  }

  const listMatch = await findListByNameInWorkspace(normalized, spaces);
  if (listMatch) return listMatch;

  throw new Error(
    `Location "${name}" not found (no space, folder, or list). Top-level spaces: ${spaces
      .map((s) => s.name)
      .join(", ")}`
  );
}

/**
 * Resolve the list used for new tasks.
 * @param {{ id: string, type: 'space' | 'folder' | 'list' }} location
 */
async function getDefaultListForSpace(location) {
  if (location.type === "list") {
    return { id: location.id };
  }

  if (location.type === "folder") {
    const listsRes = await axios.get(
      `${V2}/folder/${location.id}/list?archived=false`,
      { headers: headers() }
    );
    const lists = listsRes.data.lists || [];
    const chosen = pickDefaultList(lists);
    if (!chosen) {
      throw new Error(`No lists found in folder ${location.id}`);
    }
    return chosen;
  }

  const spaceId = location.id;

  const rootRes = await axios.get(`${V2}/space/${spaceId}/list?archived=false`, {
    headers: headers(),
  });
  const rootPick = pickDefaultList(rootRes.data.lists || []);
  if (rootPick) return rootPick;

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
    const chosen = pickDefaultList(listsRes.data.lists || []);
    if (chosen) return chosen;
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
 * Query for incomplete work across the workspace.
 * Do not filter by status name — ClickUp uses custom statuses ("TO DO", etc.); wrong names return zero tasks.
 */
function openTaskQueryBase() {
  const qs = new URLSearchParams();
  qs.set("archived", "false");
  qs.set("include_closed", "false");
  return qs;
}

/**
 * Open tasks for a space, folder (project_ids), or list.
 * @param {{ id: string, type: 'space' | 'folder' | 'list' }} location
 */
async function getOpenTasksForLocation(location) {
  const qs = openTaskQueryBase();

  if (location.type === "space") {
    const res = await axios.get(
      `${V2}/space/${location.id}/task?${qs.toString()}`,
      { headers: headers() }
    );
    return res.data.tasks || [];
  }

  if (location.type === "list") {
    const res = await axios.get(
      `${V2}/list/${location.id}/task?${qs.toString()}`,
      { headers: headers() }
    );
    return res.data.tasks || [];
  }

  qs.append("project_ids[]", location.id);
  const res = await axios.get(
    `${V2}/team/${process.env.CLICKUP_TEAM_ID}/task?${qs.toString()}`,
    { headers: headers() }
  );
  return res.data.tasks || [];
}

async function getOpenTasksForSpace(spaceId) {
  return getOpenTasksForLocation({ id: String(spaceId), type: "space" });
}

/** Paginated active tasks for one space (all non-closed statuses; includes nested folder lists when API returns them). */
async function getAllOpenTasksForSpace(spaceId) {
  const all = [];
  let page = 0;
  for (;;) {
    const qs = openTaskQueryBase();
    qs.set("page", String(page));
    const res = await axios.get(
      `${V2}/space/${spaceId}/task?${qs.toString()}`,
      { headers: headers() }
    );
    const tasks = res.data.tasks || [];
    all.push(...tasks);
    if (tasks.length < 100) break;
    page += 1;
  }
  return all;
}

/**
 * Workspace-wide active tasks (paginated). Same scope as ClickUp’s “All Tasks” for the team:
 * every list, including under folders, regardless of custom status names.
 */
async function getAllActiveTasksForTeam() {
  const all = [];
  let page = 0;
  const teamId = process.env.CLICKUP_TEAM_ID;
  for (;;) {
    const qs = openTaskQueryBase();
    qs.set("page", String(page));
    const res = await axios.get(
      `${V2}/team/${teamId}/task?${qs.toString()}`,
      { headers: headers() }
    );
    const tasks = res.data.tasks || [];
    all.push(...tasks);
    if (tasks.length < 100) break;
    page += 1;
  }
  return all;
}

/** Paginated active tasks for a space, folder, or list (same query rules as team-wide). */
async function getAllActiveTasksForLocation(location) {
  const all = [];
  let page = 0;
  const teamId = process.env.CLICKUP_TEAM_ID;
  for (;;) {
    const qs = openTaskQueryBase();
    qs.set("page", String(page));
    let res;
    if (location.type === "space") {
      res = await axios.get(
        `${V2}/space/${location.id}/task?${qs.toString()}`,
        { headers: headers() }
      );
    } else if (location.type === "list") {
      res = await axios.get(
        `${V2}/list/${location.id}/task?${qs.toString()}`,
        { headers: headers() }
      );
    } else {
      qs.append("project_ids[]", location.id);
      res = await axios.get(
        `${V2}/team/${teamId}/task?${qs.toString()}`,
        { headers: headers() }
      );
    }
    const tasks = res.data.tasks || [];
    all.push(...tasks);
    if (tasks.length < 100) break;
    page += 1;
  }
  return all;
}

// ─── Docs ─────────────────────────────────────────────────────────────────────

/** ClickUp rejects very large page payloads; keep a margin under typical limits. */
const MAX_DOC_MARKDOWN_CHARS = 350_000;

/**
 * Create a Doc under a Space, Folder, or List (ClickUp v3 Docs API).
 * Uses the default first page, then replaces its content (avoids a second root page, which can 400).
 * @param {{ id: string, type: 'space' | 'folder' | 'list' }} parentLoc
 * Returns { id, url }
 */
async function createDoc(parentLoc, title, content) {
  const parentType =
    parentLoc.type === "folder" ? 5 : parentLoc.type === "list" ? 6 : 4; // 4 Space, 5 Folder, 6 List

  let body = content;
  if (body.length > MAX_DOC_MARKDOWN_CHARS) {
    const tail =
      `\n\n---\n\n_(Raw transcript truncated: ${body.length} chars → ${MAX_DOC_MARKDOWN_CHARS} max for ClickUp.)_`;
    body = body.slice(0, MAX_DOC_MARKDOWN_CHARS - tail.length) + tail;
  }

  const ws = workspaceIdV3();

  let docId;
  try {
    const docRes = await axios.post(
      `${V3}/workspaces/${ws}/docs`,
      {
        name: title,
        parent: {
          id: String(parentLoc.id),
          type: parentType,
        },
      },
      { headers: headers() }
    );
    docId = docRes.data.id;
  } catch (err) {
    throw new Error(formatAxiosError(err, "ClickUp create doc"));
  }

  let pageId;
  try {
    const pagesRes = await axios.get(
      `${V3}/workspaces/${ws}/docs/${docId}/pages`,
      {
        params: { max_page_depth: -1, content_format: "text/md" },
        headers: headers(),
      }
    );
    const roots = pagesRes.data;
    const first =
      Array.isArray(roots) && roots.length > 0
        ? roots[0]
        : roots?.pages?.[0] || null;
    pageId = first?.id;
    if (!pageId) {
      throw new Error(
        "ClickUp create doc: no root page returned from GET /pages — cannot attach content"
      );
    }
  } catch (err) {
    if (err.response) {
      throw new Error(formatAxiosError(err, "ClickUp list doc pages"));
    }
    throw err;
  }

  try {
    await axios.put(
      `${V3}/workspaces/${ws}/docs/${docId}/pages/${pageId}`,
      {
        name: title,
        content: body,
        content_format: "text/md",
        content_edit_mode: "replace",
      },
      { headers: headers() }
    );
  } catch (err) {
    throw new Error(formatAxiosError(err, "ClickUp edit doc page"));
  }

  return {
    id: docId,
    url: `https://app.clickup.com/${process.env.CLICKUP_TEAM_ID}/docs/${docId}`,
    name: title,
  };
}

// ─── Sandbox bulk delete (destructive) ─────────────────────────────────────

async function deleteTaskById(taskId) {
  await axios.delete(`${V2}/task/${taskId}`, { headers: headers() });
}

/**
 * Preferred “done” names when a list has multiple `type: closed` statuses.
 * Optional: CLICKUP_DONE_STATUS, CLICKUP_DONE_STATUS_ALT (comma-separated).
 */
function doneStatusCandidates() {
  const primary = (process.env.CLICKUP_DONE_STATUS || "").trim();
  const alts = String(process.env.CLICKUP_DONE_STATUS_ALT || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const fallback = [
    "complete",
    "Complete",
    "closed",
    "Closed",
    "done",
    "Done",
  ];
  const seen = new Set();
  const out = [];
  for (const s of [...(primary ? [primary] : []), ...alts, ...fallback]) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** listId or `space:${id}` → resolved closed status label */
const listClosedStatusCache = new Map();

async function getStatusesForTask(taskId) {
  const taskRes = await axios.get(`${V2}/task/${taskId}`, { headers: headers() });
  const data = taskRes.data || {};
  const listId = data.list?.id != null ? String(data.list.id) : null;
  if (listId) {
    const listRes = await axios.get(`${V2}/list/${listId}`, { headers: headers() });
    const st = listRes.data?.statuses || [];
    if (st.length) return { statuses: st, cacheKey: listId };
  }
  const spaceId = data.space?.id;
  if (spaceId != null) {
    const spaceRes = await axios.get(`${V2}/space/${spaceId}`, { headers: headers() });
    const st = spaceRes.data?.statuses || [];
    if (st.length) return { statuses: st, cacheKey: `space:${spaceId}` };
  }
  return { statuses: [], cacheKey: listId || (spaceId != null ? `space:${spaceId}` : "unknown") };
}

/**
 * Pick the API-exact status string for “done” on this list.
 * Uses statuses from GET /list where type is "closed", else name match against candidates.
 */
function resolveClosedStatusForList(statuses, preferredCandidates) {
  const lower = (s) => String(s).toLowerCase();
  const closed = statuses.filter((s) => lower(s.type) === "closed");
  const pickByName = (pool) => {
    for (const pref of preferredCandidates) {
      const hit = pool.find((st) => lower(st.status) === lower(pref));
      if (hit) return hit.status;
    }
    return null;
  };
  if (closed.length > 0) {
    const named = pickByName(closed);
    if (named) return named;
    return closed[0].status;
  }
  for (const pref of preferredCandidates) {
    const hit = statuses.find((st) => lower(st.status) === lower(pref));
    if (hit) return hit.status;
  }
  return null;
}

/**
 * Move a task to that list’s closed status (ITEM_114-safe: uses GET list statuses, not guessed names).
 * @returns {{ status: string }}
 */
async function markTaskComplete(taskId) {
  const id = String(taskId).trim();
  if (!id) throw new Error("Missing task id");

  const { statuses, cacheKey } = await getStatusesForTask(id);
  let statusName = listClosedStatusCache.get(cacheKey);
  if (!statusName) {
    const candidates = doneStatusCandidates();
    statusName = resolveClosedStatusForList(statuses, candidates);
    if (!statusName) {
      const names = statuses.map((s) => s.status).join(", ") || "(none)";
      throw new Error(
        `Could not find a closed status for this task’s list/space. Valid names: ${names}. Set CLICKUP_DONE_STATUS to the exact “done” column name.`
      );
    }
    listClosedStatusCache.set(cacheKey, statusName);
  }

  try {
    await axios.put(
      `${V2}/task/${id}`,
      { status: statusName },
      { headers: headers() }
    );
    return { status: statusName };
  } catch (err) {
    listClosedStatusCache.delete(cacheKey);
    throw new Error(formatAxiosError(err, "ClickUp mark complete"));
  }
}

/** Tasks in a list, paginated (100/page), including closed and subtasks. */
async function getAllTasksInList(listId) {
  const all = [];
  let page = 0;
  for (;;) {
    const res = await axios.get(`${V2}/list/${listId}/task`, {
      headers: headers(),
      params: {
        page,
        include_closed: true,
        subtasks: true,
      },
    });
    const tasks = res.data.tasks || [];
    all.push(...tasks);
    if (tasks.length < 100) break;
    page += 1;
  }
  return all;
}

/**
 * Delete every task in every list directly under this folder (not nested subfolders).
 * @returns {{ listCount: number, taskCount: number }}
 */
async function deleteAllTasksInFolder(folderId) {
  const listsRes = await axios.get(
    `${V2}/folder/${folderId}/list?archived=false`,
    { headers: headers() }
  );
  const lists = listsRes.data.lists || [];
  let taskCount = 0;
  for (const list of lists) {
    const tasks = await getAllTasksInList(list.id);
    for (const t of tasks) {
      try {
        await deleteTaskById(t.id);
        taskCount += 1;
      } catch (err) {
        if (err.response?.status !== 404) throw err;
      }
    }
  }
  return { listCount: lists.length, taskCount };
}

/** List docs for a ClickUp parent (v3). parentType: FOLDER | SPACE | LIST */
async function listDocsWithParent(parentId, parentType) {
  const ws = workspaceIdV3();
  const all = [];
  let cursor;
  for (;;) {
    const params = {
      parent_id: String(parentId),
      parent_type: parentType,
      limit: 100,
    };
    if (cursor) params.cursor = cursor;
    const res = await axios.get(`${V3}/workspaces/${ws}/docs`, {
      headers: headers(),
      params,
    });
    all.push(...(res.data.docs || []));
    if (!res.data.next_cursor) break;
    cursor = res.data.next_cursor;
  }
  return all;
}

async function searchDocsUnderFolder(folderId) {
  return listDocsWithParent(folderId, "FOLDER");
}

async function listAllDocsInFolderTree(folderId) {
  const all = [...(await listDocsWithParent(folderId, "FOLDER"))];
  const subs = await getSubfolders(folderId);
  for (const s of subs) {
    const inner = await listAllDocsInFolderTree(s.id);
    all.push(...inner);
  }
  return all;
}

/** Docs whose parent is the space, plus every folder under the space (nested). */
async function listAllDocsInSpace(spaceId) {
  const all = [...(await listDocsWithParent(spaceId, "SPACE"))];
  const stack = [];
  const topRes = await axios.get(
    `${V2}/space/${spaceId}/folder?archived=false`,
    { headers: headers() }
  );
  for (const f of topRes.data.folders || []) stack.push(f);
  while (stack.length > 0) {
    const folder = stack.pop();
    const docs = await listDocsWithParent(folder.id, "FOLDER");
    all.push(...docs);
    const subs = await getSubfolders(folder.id);
    for (const s of subs) stack.push(s);
  }
  return all;
}

/**
 * All docs under a resolved location (space / folder incl. subfolders / list).
 */
async function listAllDocsForLocation(location) {
  if (location.type === "space") return listAllDocsInSpace(location.id);
  if (location.type === "folder") return listAllDocsInFolderTree(location.id);
  if (location.type === "list") return listDocsWithParent(location.id, "LIST");
  throw new Error(`Unknown location type: ${location.type}`);
}

/** Workspace-wide doc index (deduped). Can be large — caller should trim. */
async function listAllDocsInWorkspace() {
  const spaces = await getSpaces();
  const all = [];
  const seen = new Set();
  for (const sp of spaces) {
    try {
      const docs = await listAllDocsInSpace(sp.id);
      for (const d of docs) {
        if (!d?.id || seen.has(d.id)) continue;
        seen.add(d.id);
        all.push(d);
      }
    } catch (err) {
      console.warn(`listAllDocsInWorkspace space "${sp.name}": ${err.message}`);
    }
  }
  return all;
}

function collectPageMarkdown(nodes, out) {
  if (!nodes) return;
  const arr = Array.isArray(nodes) ? nodes : [];
  for (const n of arr) {
    if (typeof n.content === "string" && n.content.trim()) out.push(n.content);
    if (n.pages?.length) collectPageMarkdown(n.pages, out);
    if (n.children?.length) collectPageMarkdown(n.children, out);
  }
}

/**
 * Map ClickUp doc parent payload to { id, type } for createDoc.
 */
function locationFromDocParent(parent) {
  if (!parent || parent.id == null) return null;
  const id = String(parent.id);
  const t = parent.type;
  if (t === 5 || t === "FOLDER" || t === "folder") return { id, type: "folder" };
  if (t === 6 || t === "LIST" || t === "list") return { id, type: "list" };
  if (t === 4 || t === "SPACE" || t === "space") return { id, type: "space" };
  return null;
}

/** GET single doc (parent for createDoc placement). */
async function getDocParentLocation(docId) {
  const ws = workspaceIdV3();
  try {
    const res = await axios.get(`${V3}/workspaces/${ws}/docs/${docId}`, {
      headers: headers(),
    });
    const d = res.data || {};
    let p = d.parent;
    if (!p && d.parent_id != null) {
      p = { id: d.parent_id, type: d.parent_type };
    }
    return locationFromDocParent(p);
  } catch {
    return null;
  }
}

/**
 * Concatenate markdown from all pages of a doc (root + nested pages when API returns them).
 */
async function getDocMarkdownById(docId) {
  const ws = workspaceIdV3();
  const res = await axios.get(
    `${V3}/workspaces/${ws}/docs/${docId}/pages`,
    {
      params: { max_page_depth: -1, content_format: "text/md" },
      headers: headers(),
    }
  );
  const roots = res.data;
  const top = Array.isArray(roots) ? roots : roots?.pages || [];
  const parts = [];
  collectPageMarkdown(top, parts);
  return parts.join("\n\n---\n\n").trim();
}

/**
 * Public v3 docs: GET works; DELETE often returns 405 (not in public spec).
 * Try DELETE, then PATCH/PUT archive, then a few guessed routes.
 */
async function removeSingleDoc(docId) {
  const ws = workspaceIdV3();
  const base = `${V3}/workspaces/${ws}/docs/${docId}`;

  const attempts = [
    () => axios.delete(base, { headers: headers() }),
    () =>
      axios.patch(
        base,
        { archived: true },
        { headers: headers() }
      ),
    () =>
      axios.put(
        base,
        { archived: true },
        { headers: headers() }
      ),
    () =>
      axios.post(
        `${base}/archive`,
        {},
        { headers: headers() }
      ),
    () =>
      axios.post(
        `${base}/trash`,
        {},
        { headers: headers() }
      ),
  ];

  let lastDetail = "";
  for (const run of attempts) {
    try {
      await run();
      return { ok: true };
    } catch (err) {
      const st = err.response?.status;
      lastDetail = err.response
        ? formatAxiosError(err, "doc")
        : err.message;
      if (st === 404) return { ok: true };
      if (st === 405 || st === 400 || st === 422) continue;
      return { ok: false, detail: lastDetail };
    }
  }
  return { ok: false, detail: lastDetail || "no supported remove method" };
}

/**
 * Remove docs under folder (best-effort; ClickUp may reject all write methods).
 * @returns {{ docCount: number, scanned: number, errors: string[], apiLimited?: boolean }}
 */
async function deleteAllDocsInFolder(folderId) {
  const docs = await searchDocsUnderFolder(folderId);
  const errors = [];
  let docCount = 0;

  for (const d of docs) {
    if (d.deleted) continue;
    const res = await removeSingleDoc(d.id);
    if (res.ok) {
      docCount += 1;
    } else {
      errors.push(`${d.id}: ${res.detail}`);
    }
  }

  const apiLimited =
    docCount === 0 &&
    errors.length > 0 &&
    errors.every((e) => e.includes("405"));

  return {
    docCount,
    scanned: docs.length,
    errors,
    apiLimited,
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
  getSpaces,
  findSpaceByName,
  getDefaultListForSpace,
  createTask,
  deleteTaskById,
  markTaskComplete,
  getOpenTasksForSpace,
  getOpenTasksForLocation,
  getAllOpenTasksForSpace,
  getAllActiveTasksForTeam,
  getAllActiveTasksForLocation,
  listDocsWithParent,
  listAllDocsForLocation,
  listAllDocsInWorkspace,
  getDocMarkdownById,
  getDocParentLocation,
  locationFromDocParent,
  createDoc,
  deleteAllTasksInFolder,
  deleteAllDocsInFolder,
  getTeamMembers,
};
