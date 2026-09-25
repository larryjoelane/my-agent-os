#!/usr/bin/env node
// session CLI — list saved sessions, or print one back for reading into a
// new session. Thin shell: arg parsing and stdout/stderr only, all real
// work delegates to sessionIndex.js.
//
// Requires --experimental-sqlite (node:sqlite is still experimental as
// of Node 22.x/23.x).
//
// Usage:
//   node --experimental-sqlite session.js list [--no-extract]
//   node --experimental-sqlite session.js show <session-id|name> [--json | --raw] [--out FILE]
//
// Output: `list` and `show --json` print JSON (`list` also extracts each
// raw archive to .myagent/sessions/extracted/ and reports the path); `show` prints the saved
// transcript as Markdown under a short header; `show --raw` prints the
// original raw log byte-for-byte. With --out, `show` writes to the file
// instead and prints a JSON receipt. Errors go to stderr.

const fs = require('fs');
const path = require('path');
const sessionIndex = require('./sessionIndex');

const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(process.cwd(), '.myagent', 'sessions');
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');

function parseArgs(argv) {
  const out = { command: null, target: null, json: false, raw: false, out: null, extract: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--raw') out.raw = true;
    else if (a === '--no-extract') out.extract = false;
    else if (a === '--out' || a === '-o') out.out = argv[++i] || null;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else rest.push(a);
  }
  out.command = rest[0] || null;
  out.target = rest.slice(1).join(' ').trim() || null;
  return out;
}

function printHelp() {
  process.stderr.write([
    'session — list or show sessions saved with save-session.js',
    '',
    'Usage: node --experimental-sqlite session.js list [--no-extract]',
    '       node --experimental-sqlite session.js show <session-id|name> [--json | --raw]',
    '',
    'Options:',
    '      --no-extract     list: don\'t extract raw archives (by default each one is',
    '                       decompressed to extracted/<id>.jsonl, skipped if current)',
    '      --json           show: print the full row as JSON instead of Markdown',
    '      --raw            show: print the original raw log (sessions saved with --raw),',
    '                       decompressed if it was archived gzipped',
    '  -o, --out FILE       show: write to FILE instead of stdout (use for --raw:',
    '                       shell redirection can re-encode the bytes)',
    '  -h, --help           show this help',
    '',
  ].join('\n') + '\n');
}

// session row -> Markdown: header with name/id/themes/summary, then transcript.
function renderSession(s) {
  return [
    `# Session: ${s.name}`,
    '',
    `- id: ${s.session_id}`,
    `- saved: ${s.created_ts}${s.updated_ts !== s.created_ts ? ` (updated ${s.updated_ts})` : ''}`,
    s.themes.length ? `- themes: ${s.themes.join(', ')}` : null,
    s.raw_path ? `- raw log: archived (${s.raw_bytes} bytes; \`show --raw\` prints it)` : null,
    s.summary ? `\n${s.summary}` : null,
    '',
    '---',
    '',
    s.transcript,
  ].filter((line) => line !== null).join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = sessionIndex.open(INDEX_DB_PATH);

  if (args.command === 'list') {
    process.stdout.write(JSON.stringify({
      sessions: args.extract
        ? sessionIndex.listSessionsExtracted(db, SESSIONS_DIR)
        : sessionIndex.listSessions(db),
    }, null, 2) + '\n');
    return;
  }
  if (args.command === 'show') {
    if (!args.target) {
      process.stderr.write('error: show needs a session id or name (use --help)\n');
      process.exit(2);
    }
    const session = sessionIndex.getSession(db, args.target);
    if (!session) {
      process.stderr.write(`error: no saved session with id or name "${args.target}"\n`);
      process.exit(1);
    }
    let output;
    if (args.raw) {
      output = sessionIndex.getRawLog(SESSIONS_DIR, session);
      if (!output) {
        process.stderr.write(`error: session "${session.name}" was saved without --raw, so it has no raw log\n`);
        process.exit(1);
      }
    } else {
      output = args.json ? JSON.stringify(session, null, 2) + '\n' : renderSession(session);
    }
    if (args.out) {
      fs.writeFileSync(args.out, output);
      process.stdout.write(JSON.stringify({ ok: true, name: session.name, sessionId: session.session_id, out: path.resolve(args.out), bytes: Buffer.byteLength(output) }) + '\n');
    } else {
      process.stdout.write(output);
    }
    return;
  }
  process.stderr.write('error: expected "list" or "show" (use --help)\n');
  process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`session failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
