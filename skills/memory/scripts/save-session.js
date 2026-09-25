#!/usr/bin/env node
// save-session CLI — store a whole agent session (condensed transcript +
// name/themes/summary) for retrieval later. Thin shell: arg parsing,
// stdin handling, and stdout/stderr only; all real work delegates to
// sessionIndex.js.
//
// The transcript arrives on stdin, already condensed by an agent adapter
// (e.g. adapters/claude-code/condense-transcript.js) — this script never
// reads an agent's native log format itself.
//
// Requires --experimental-sqlite (node:sqlite is still experimental as
// of Node 22.x/23.x).
//
// Usage:
//   <condenser> | node --experimental-sqlite save-session.js --name "..." --themes a,b --summary "..."
//
// Output: JSON to stdout. Errors go to stderr.

const fs = require('fs');
const path = require('path');
const sessionIndex = require('./sessionIndex');

const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(process.cwd(), '.myagent', 'sessions');
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');
// Written by the agent adapter's session hook: { session_id, transcript_path, ... }.
const CURRENT_SESSION_PATH = path.join(SESSIONS_DIR, 'current.json');

function parseArgs(argv) {
  const out = { name: null, themes: [], summary: null, sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') out.name = (argv[++i] || '').trim() || null;
    else if (a === '--themes' || a === '-t') out.themes = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--summary') out.summary = (argv[++i] || '').trim() || null;
    else if (a === '--session-id') out.sessionId = (argv[++i] || '').trim() || null;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { process.stderr.write(`error: unknown argument: ${a} (use --help)\n`); process.exit(2); }
  }
  return out;
}

function printHelp() {
  process.stderr.write([
    'save-session — store a condensed session transcript for later retrieval',
    '',
    'Usage: <condensed transcript on stdin> | node --experimental-sqlite save-session.js --name NAME [options]',
    '',
    'Options:',
    '      --name NAME        short name for the session, from its theme(s) (required)',
    '  -t, --themes a,b,c     comma-separated themes',
    '      --summary TEXT     a few lines on what the session covered',
    '      --session-id ID    session to save (default: session_id in current.json)',
    '  -h, --help             show this help',
    '',
    'Re-saving the same session id updates it in place.',
    '',
  ].join('\n') + '\n');
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

// -> session_id recorded by the adapter hook | null.
function currentSessionId() {
  try {
    return JSON.parse(fs.readFileSync(CURRENT_SESSION_PATH, 'utf8')).session_id || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name) {
    process.stderr.write('error: --name is required (use --help)\n');
    process.exit(2);
  }
  const sessionId = args.sessionId || currentSessionId();
  if (!sessionId) {
    process.stderr.write(`error: no --session-id given and none recorded in ${CURRENT_SESSION_PATH}\n`);
    process.exit(2);
  }
  const transcript = (await readStdin()).trim();
  if (!transcript) {
    process.stderr.write('error: no transcript on stdin (pipe in the adapter\'s condensed transcript)\n');
    process.exit(2);
  }

  const db = sessionIndex.open(INDEX_DB_PATH);
  const result = sessionIndex.storeSession(db, {
    sessionId,
    name: args.name,
    themes: args.themes,
    summary: args.summary,
    transcript,
  });
  process.stdout.write(JSON.stringify({ ok: true, ...result, transcriptChars: transcript.length }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`save-session failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
