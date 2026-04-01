// scripts/get-members.js
// Run this once to find your ClickUp user ID:
//   node scripts/get-members.js

require("dotenv").config();
const { getTeamMembers } = require("../src/clickup");

(async () => {
  const members = await getTeamMembers();
  console.log("\nClickUp Team Members:\n");
  members.forEach((m) => {
    console.log(`  ID: ${m.id}  |  ${m.username}  |  ${m.email}`);
  });
  console.log("\nCopy your numeric ID into CLICKUP_JOSH_USER_ID in .env\n");
})();
