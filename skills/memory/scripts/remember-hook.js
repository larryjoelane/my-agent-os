#!/usr/bin/env node
// UserPromptSubmit hook — when the user's prompt asks to remember
// something, inject a reminder telling the agent to save it via
// recall-store.js (a fact) or save-session.js (the whole session); when
// it asks for a saved session back, remind the agent how to retrieve it
// (including decompressing a gzipped raw log). Doesn't save or fetch
// anything itself: that needs the agent, this only makes sure the right
// steps aren't skipped.
//
// Input: hook JSON on stdin ({ prompt, ... }). Output: hook JSON on
// stdout with additionalContext, or nothing when the prompt doesn't match.

// "save this" / "note that" only count as a directive — followed by a
// colon or dash, "for later"/"to memory", or ending the prompt — since
// "save this file" and "note that the build fails" are ordinary requests.
const TRIGGER = /\b(remember (this|that)|don'?t forget|keep in mind|from now on)\b|\b(save|note) (this|that)(\s*[:\-—]|\s+(for later|to memory|in memory)\b|[\s.!]*$)/i;
// Checked first: "save this session" would otherwise match "save this".
// "remember" only with "this": "do you remember our session" is a question.
const SESSION_TRIGGER = /\b((save|store|archive) (this|the|our|current)|remember this) ((whole|entire|full|raw|complete) )*(session|conversation|chat)\b/i;
// Retrieving a saved session: a fetch verb, then either a qualifier that
// marks it as a *saved* one ("the last session", "my previous chat"), a
// raw/session log, or a saved session's kebab-case name. "log" alone
// isn't enough — "read the last log line" is about something else.
const RETRIEVE_TRIGGER = new RegExp(
  '\\b(show|load|open|restore|retrieve|get|fetch|pull up|bring back|read|export)\\b[^.?!]{0,40}' +
  '(\\b(raw|saved|previous|last|earlier|old|past)\\b[^.?!]{0,30}\\b(session|conversation|chat)s?\\b' +
  '|\\b(raw|session) (log|transcript)s?\\b' +
  '|\\bsession [a-z0-9]+(-[a-z0-9]+)+)',
  'i',
);
// Save or retrieve, "raw" means the native log: "save this raw session",
// "show me the raw log".
const RAW_WORD = /\braw\b/i;

const FACT_REMINDER =
  'The user asked to remember something. Load the memory skill and save the ' +
  'fact with recall-store.js (skills/memory/scripts/recall-store.js), then ' +
  'report the returned id.';
const SESSION_REMINDER =
  'The user asked to save this whole session. Load the memory skill and follow ' +
  'its "Save a session" section: pick a name and themes from what the session ' +
  'covered, write a short summary, and pipe the condensed transcript into ' +
  'save-session.js. Report the returned session id and name.';
const RAW_SESSION_REMINDER = SESSION_REMINDER +
  ' The user asked for the raw session: pass --raw to save-session.js so the ' +
  'full native log is archived too, and report its size.';
const RETRIEVE_REMINDER =
  'The user asked to retrieve a saved session. Load the memory skill and follow ' +
  'its "Retrieve a session" section: find it with session.js list (or recall.js ' +
  '"<topic>" --kind session), then read it with session.js show <name>.';
const RAW_RETRIEVE_REMINDER =
  'The user asked for a saved session\'s raw log. Load the memory skill, find the ' +
  'session with session.js list (entries with a raw_path have one), then run ' +
  'session.js show <name> --raw --out <file>.jsonl. Raw archives are gzipped ' +
  '(.gz) and show --raw decompresses them, so never read or copy the .gz file ' +
  'directly, and use --out rather than shell redirection so the bytes are not ' +
  're-encoded. Don\'t read the whole log into context; report the file path and size.';

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
  const raw = RAW_WORD.test(prompt);
  if (SESSION_TRIGGER.test(prompt)) return raw ? RAW_SESSION_REMINDER : SESSION_REMINDER;
  if (RETRIEVE_TRIGGER.test(prompt)) return raw ? RAW_RETRIEVE_REMINDER : RETRIEVE_REMINDER;
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
