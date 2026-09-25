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
// With --raw, the agent's native log is also archived byte-for-byte
// (gzipped, see rawArchive.js) — copied as-is, never parsed here.
//
// Usage:
//   <condenser> | node --experimental-sqlite save-session.js --name "..." --themes a,b --summary "..."
//   <condenser> | node --experimental-sqlite save-session.js --raw --name "..." ...
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
  const out = { name: null, themes: [], summary: null, sessionId: null, raw: false, rawPath: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--raw') out.raw = true;
    else if (a === '--raw-path') { out.raw = true; out.rawPath = (argv[++i] || '').trim() || null; }
    else if (a === '--name') out.name = (argv[++i] || '').trim() || null;
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
    '      --raw              also archive the agent\'s raw session log, gzipped',
    '      --raw-path PATH    raw log to archive (implies --raw; default:',
    '                         transcript_path in current.json)',
    '  -h, --help             show this help',
    '',
    'Re-saving the same session id updates it in place; a re-save without',
    '--raw keeps any raw archive from an earlier save.',
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

// -> what the adapter hook recorded ({ session_id, transcript_path, ... }) | {}.
function readCurrent() {
  try {
    return JSON.parse(fs.readFileSync(CURRENT_SESSION_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name) {
    process.stderr.write('error: --name is required (use --help)\n');
    process.exit(2);
  }
  const current = readCurrent();
  const sessionId = args.sessionId || current.session_id;
  if (!sessionId) {
    process.stderr.write(`error: no --session-id given and none recorded in ${CURRENT_SESSION_PATH}\n`);
    process.exit(2);
  }
  // current.json's transcript is only this session's when the ids agree.
  const rawPath = args.rawPath || (sessionId === current.session_id ? current.transcript_path : null);
  if (args.raw && !rawPath) {
    process.stderr.write(`error: --raw needs a log to archive: pass --raw-path, or save the session recorded in ${CURRENT_SESSION_PATH}\n`);
    process.exit(2);
  }
  if (args.raw && !fs.existsSync(rawPath)) {
    process.stderr.write(`error: raw log not found: ${rawPath}\n`);
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
    raw: args.raw ? { sessionsDir: SESSIONS_DIR, sourcePath: rawPath } : null,
  });
  process.stdout.write(JSON.stringify({ ok: true, ...result, transcriptChars: transcript.length }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`save-session failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
