# DDC ClickUp Bot

Telegram bot that creates ClickUp tasks and docs from structured messages.
Sends 9am + 3pm task digests automatically.

---

## Stack

- **Node.js** + Express (webhook server)
- **Telegram Bot API** (messaging)
- **ClickUp API v2/v3** (tasks + docs)
- **Anthropic Claude API** (meeting analysis)
- **node-cron** (scheduled digests)
- **Railway** (hosting, ~$7/mo)

---

## Setup (do this once)

### 1. Create your Telegram Bot

1. Open Telegram, message `@BotFather`
2. Send `/newbot`, follow prompts
3. Copy the **token** → `TELEGRAM_BOT_TOKEN`
4. Message `@userinfobot` to get your **personal chat ID** → `TELEGRAM_CHAT_ID`

### 2. Get your ClickUp credentials

1. **API Token**: ClickUp → Settings → Apps → API Token → `CLICKUP_API_TOKEN`
2. **Team ID**: Open ClickUp in browser — the URL is `app.clickup.com/{TEAM_ID}/home` → `CLICKUP_TEAM_ID`
3. **Your User ID**: Settings → Profile → scroll to bottom → copy numeric ID → `CLICKUP_JOSH_USER_ID`
   - Or run: `node scripts/get-members.js` after setup to see all member IDs

### 3. Get your Anthropic API key

https://console.anthropic.com → API Keys → `ANTHROPIC_API_KEY`

### 4. Configure spaces for the digest

Open `src/cron.js` and update `DIGEST_SPACES` array to match your exact ClickUp space names.

### 5. Install and run locally

```bash
npm install
cp .env.example .env
# Fill in your .env values
npm run dev
```

You won't have a public URL yet for the Telegram webhook — that's fine for local testing.
Test the ClickUp + Claude integration by calling handler functions directly.

### 6. Deploy to the cloud (Railway)

The bot needs **one** long-lived process and a **public HTTPS** URL so Telegram can POST to `/webhook`. Easiest path here is **Railway**; you can also run the included **`Dockerfile`** on Fly.io, Cloud Run, etc.

**Railway (GitHub)**

1. Push this repo to GitHub.
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub** → pick the repo.
3. **Variables**: add everything from your `.env`. You may leave `WEBHOOK_URL` empty on the first deploy.
4. Deploy, then **Settings → Networking → Generate domain** and copy the HTTPS origin.
5. Set **`WEBHOOK_URL`** to that URL (e.g. `https://your-service.up.railway.app`; trailing slash is OK). Redeploy if needed; on startup the app registers `setWebhook` → `{WEBHOOK_URL}/webhook`.
6. Logs should show “Telegram webhook registered”; `GET /` should return JSON.

**Docker**

```bash
docker build -t clickup-bot .
docker run --env-file .env -p 3000:3000 clickup-bot
```

Use the same env vars as `.env.example`. Platforms usually set `PORT` automatically.

| Variable | Cloud |
|----------|--------|
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Required |
| `CLICKUP_*`, `ANTHROPIC_API_KEY` | Required |
| `WEBHOOK_URL` | **Required** — public HTTPS base URL |
| `PORT` | Leave unset / use platform default |
| `TIMEZONE` | Digest schedule (cron) |

---

## Usage

Send any of these to your bot in Telegram:

### Create a task
```
task
APS
Follow up with Mark on the gold layer timeline
Optional description or context here
```

### Process a meeting
```
meeting
APS
3.27.26 Weekly Sync with Mark & Jen
[paste full meeting transcript here]
```

### Commands
- `/digest` — get your task digest right now
- `/help` — show usage

---

## APS transcript ingestion (additive)

When `spaceName === "APS"`, after the normal ClickUp flow completes (doc + tasks + duplicate review if any), the bot **additionally**:

1. Fetches `views/entity-index.json` from the `aps-master` repo via GitHub API (falls back to tree-scan if missing)
2. Calls Claude `catalogueTranscript()` to extract structured frontmatter:
   - `attendees`, `people`, `workstreams`, `systems` → matched to canonical entity IDs
   - `commitments` → structured `{who, what, to, due}` entries
   - New entities (not yet in the index) proposed with `confidence: low`
3. If Claude flags genuinely ambiguous identity matches → **Telegram clarification Q&A** (one question at a time; reply with a number or `skip`)
4. Writes `transcripts/<YYYY-MM-DD-slug>.md` to aps-master via Contents API
5. Telegram reply: `📚 APS transcript archived + catalogued. Attendees: X. Workstreams: Y. Commitments: N. <github URL>`

Clarification questions arrive **only after** the ClickUp flow's final `✅` message, so the conversation stays un-jangled. Cancel any active clarification session with `/cancel`.

**Required env:** `GITHUB_TOKEN` (PAT with repo:contents:write on aps-master), `GITHUB_REPO`, `GITHUB_BRANCH`.

## What happens with a meeting

1. Claude analyzes the transcript → extracts summary + structured todos
2. A ClickUp Doc is created in the specified space titled `DD.MM.YY_Meeting Name`
3. Doc contains: summary → action items → full raw transcript
4. Tasks are created from the todos:
   - If person = Josh → assigned to you
   - If person = anyone else → task titled `[PERSON] Task description`
   - All tasks link back to the meeting doc in their description
5. Telegram replies with the full summary + links to all created tasks

---

## File structure

```
src/
  index.js          — Express server + webhook router
  parser.js         — Parses structured Telegram messages
  telegram.js       — Sends Telegram messages
  clickup.js        — All ClickUp API calls
  claude.js         — Claude meeting analysis
  cron.js           — 9am + 3pm digest scheduler
  utils.js          — Date formatting etc
  handlers/
    meeting.js      — Full meeting processing pipeline
    task.js         — Simple task creation
```

---

## Troubleshooting

**Bot not responding:** Check Railway logs. Make sure WEBHOOK_URL is set and matches your Railway URL exactly (no trailing slash).

**"Space not found" error:** Space name in your message must match ClickUp exactly (case-insensitive). Check `DIGEST_SPACES` in cron.js too.

**ClickUp Doc not creating:** The v3 Docs API requires your token to have Docs permissions. Check ClickUp → Settings → Apps → token scopes.

**Tasks not assigning to you:** Double-check `CLICKUP_JOSH_USER_ID` — must be the numeric user ID, not username.
