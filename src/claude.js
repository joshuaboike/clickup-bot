// src/claude.js
// Calls Anthropic's API to analyze meeting transcripts and extract structured todos.

const axios = require("axios");

/**
 * Analyzes a meeting transcript.
 * Returns { summary: string, todos: [{ person: string, task: string }] }
 *
 * The prompt instructs Claude to return ONLY valid JSON — no markdown fences,
 * no preamble — so we can parse it directly.
 */
async function analyzeMeeting(transcript) {
  const response = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
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
          content: `Please analyze this meeting transcript and extract all key information and action items:\n\n${transcript}`,
        },
      ],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    }
  );

  const raw = response.data.content[0].text.trim();

  // Strip markdown code fences if Claude includes them despite instructions
  const cleaned = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("Failed to parse Claude response as JSON:", cleaned);
    // Return a graceful fallback so the pipeline doesn't crash
    return {
      summary: cleaned, // put raw output in summary
      todos: [],
    };
  }
}

module.exports = { analyzeMeeting };
