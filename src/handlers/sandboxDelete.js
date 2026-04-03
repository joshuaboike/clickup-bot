// Destructive sandbox helpers: bulk delete tasks or docs under a folder by name.

const clickup = require("../clickup");
const { sendMessage } = require("../telegram");

/**
 * @param {"list"|"docs"} target  list = all tasks in folder lists; docs = docs parented on folder
 * @param {string} folderName     e.g. "Snak King" (must resolve to a folder, not a space)
 */
async function handleSandboxBulkDelete(target, folderName) {
  const name = folderName?.trim();
  if (!name) {
    await sendMessage("❌ sandbox_delete: missing folder name.", null);
    return;
  }

  try {
    const loc = await clickup.findSpaceByName(name);
    if (loc.type !== "folder") {
      await sendMessage(
        `❌ "${name}" is a ${loc.type}, not a folder. Use a folder name (e.g. Snak King).`,
        null
      );
      return;
    }

    if (target === "list") {
      const { listCount, taskCount } = await clickup.deleteAllTasksInFolder(loc.id);
      await sendMessage(
        `✅ sandbox_delete list: removed ${taskCount} task(s) across ${listCount} list(s) in folder "${name}".`,
        null
      );
      return;
    }

    if (target === "docs") {
      const { docCount, scanned, errors, apiLimited } =
        await clickup.deleteAllDocsInFolder(loc.id);

      if (scanned === 0) {
        await sendMessage(
          `✅ sandbox_delete docs: no docs under folder "${name}".`,
          null
        );
        return;
      }

      if (apiLimited) {
        await sendMessage(
          `❌ sandbox_delete docs: ClickUp’s public API does not support deleting Docs (HTTP 405). ` +
            `Found ${scanned} doc(s) under "${name}" but none could be removed via API. ` +
            `Delete them in the ClickUp UI, or use \`/sandbox_delete ${name} list delete\` for tasks only.`,
          null
        );
        return;
      }

      let msg =
        docCount > 0
          ? `✅ sandbox_delete docs: removed ${docCount} of ${scanned} doc(s) under "${name}".`
          : `❌ sandbox_delete docs: removed 0 of ${scanned} doc(s) under "${name}".`;
      if (errors.length > 0) {
        msg += `\n⚠️ ${errors.slice(0, 2).join(" | ")}`;
        if (errors.length > 2) msg += " …";
      }
      await sendMessage(msg, null);
      return;
    }

    await sendMessage(`❌ Unknown target "${target}". Use list or docs.`, null);
  } catch (err) {
    console.error("sandboxDelete:", err.message);
    await sendMessage(`❌ sandbox_delete failed: ${err.message}`, null);
  }
}

module.exports = { handleSandboxBulkDelete };
