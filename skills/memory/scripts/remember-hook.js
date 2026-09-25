#!/usr/bin/env node
// UserPromptSubmit hook — when the user's prompt asks to remember
// something, inject a reminder telling the agent to save it via
// recall-store.js (a fact) or save-session.js (the whole session).
// Doesn't save anything itself: deciding *what* text to store needs the
// agent, this only makes sure the save isn't skipped.
//
// Input: hook JSON on stdin ({ prompt, ... }). Output: hook JSON on
// stdout with additionalContext, or nothing when the prompt doesn't match.

// "save this" / "note that" only count as a directive — followed by a
// colon or dash, "for later"/"to memory", or ending the prompt — since
// "save this file" and "note that the build fails" are ordinary requests.
const TRIGGER = /\b(remember (this|that)|don'?t forget|keep in mind|from now on)\b|\b(save|note) (this|that)(\s*[:\-—]|\s+(for later|to memory|in memory)\b|[\s.!]*$)/i;
// Checked first: "save this session" would otherwise match "save this".
// "remember" only with "this": "do you remember our session" is a question.
const SESSION_TRIGGER = /\b((save|store|archive) (this|the|our|current)|remember this) (whole |entire )?(session|conversation|chat)\b/i;

const FACT_REMINDER =
  'The user asked to remember something. Load the memory skill and save the ' +
  'fact with recall-store.js (skills/memory/scripts/recall-store.js), then ' +
  'report the returned id.';
const SESSION_REMINDER =
  'The user asked to save this whole session. Load the memory skill and follow ' +
  'its "Save a session" section: pick a name and themes from what the session ' +
  'covered, write a short summary, and pipe the condensed transcript into ' +
  'save-session.js. Report the returned session id and name.';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

// prompt -> the reminder to inject, or null. Skips /memory invocations
// (the skill is loaded then, so no reminder is needed).
function reminderFor(prompt) {
  if (!prompt || /^\s*\/memory\b/.test(prompt)) return null;
  if (SESSION_TRIGGER.test(prompt)) return SESSION_REMINDER;
  if (TRIGGER.test(prompt)) return FACT_REMINDER;
  return null;
}

async function main() {
  let input = {};
  try { input = JSON.parse(await readStdin() || '{}'); } catch { return; }
  const reminder = reminderFor(input.prompt);
  if (!reminder) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: reminder },
  }) + '\n');
}

main();
