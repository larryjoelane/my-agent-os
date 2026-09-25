#!/usr/bin/env node
// SessionStart / UserPromptSubmit hook — record which Claude Code session
// is current, so the memory skill's save-session.js knows its session id
// and condense-transcript.js knows which log to read, without guessing
// from file timestamps.
//
// Input: hook JSON on stdin ({ session_id, transcript_path, cwd, ... }).
// Writes .myagent/sessions/current.json under the project. Prints
// nothing, and never fails the prompt — a bad payload just skips the write.

const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  let input;
  try { input = JSON.parse(await readStdin() || '{}'); } catch { return; }
  if (!input.session_id) return;

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const sessionsDir = process.env.MYAGENT_SESSIONS_DIR || path.join(projectDir, '.myagent', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, 'current.json'), JSON.stringify({
    agent: 'claude-code',
    session_id: input.session_id,
    transcript_path: input.transcript_path || null,
    updated_ts: new Date().toISOString(),
  }, null, 2) + '\n');
}

main().catch(() => {});
