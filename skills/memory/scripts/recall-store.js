#!/usr/bin/env node
// recall-store CLI — write a freeform memory into this project's memory
// store. Thin shell: arg parsing, stdin handling, and stdout/stderr
// only; all real work delegates to sessionIndex.js.
//
// Requires --experimental-sqlite (node:sqlite is still experimental as
// of Node 22.x/23.x).
//
// Usage:
//   node --experimental-sqlite recall-store.js "user prefers tabs over spaces"
//   node --experimental-sqlite recall-store.js --source claude --tags pref,style "..."
//   echo "..." | node --experimental-sqlite recall-store.js --source hook
//
// Output: JSON to stdout. Errors go to stderr.

const path = require('path');
const sessionIndex = require('./sessionIndex');

const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(process.cwd(), '.myagent', 'sessions');
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');

function parseArgs(argv) {
  const out = { source: 'cli', tags: null, text: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' || a === '-s') out.source = argv[++i] || 'cli';
    else if (a === '--tags' || a === '-t') out.tags = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else rest.push(a);
  }
  out.text = rest.join(' ').trim() || null;
  return out;
}

function printHelp() {
  process.stderr.write([
    'recall-store — write a memory into this project\'s memory store',
    '',
    'Usage: node --experimental-sqlite recall-store.js [options] <text>',
    '       echo "<text>" | node --experimental-sqlite recall-store.js [options]',
    '',
    'Options:',
    '  -s, --source NAME    label the source (default: cli)',
    '  -t, --tags a,b,c     comma-separated tags',
    '  -h, --help           show this help',
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.text) {
    const stdin = (await readStdin()).trim();
    if (stdin) args.text = stdin;
  }
  if (!args.text) {
    process.stderr.write('error: no text provided (pass as args or pipe via stdin)\n');
    process.exit(2);
  }

  const db = sessionIndex.open(INDEX_DB_PATH);
  const result = await sessionIndex.storeMemory(db, {
    text: args.text,
    source: args.source,
    tags: args.tags,
  });
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`recall-store failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
