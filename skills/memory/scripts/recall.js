#!/usr/bin/env node
// recall CLI — TF-IDF cosine search over this project's own memory
// store. Thin shell: arg parsing and stdout/stderr only, all real work
// delegates to sessionIndex.js.
//
// Requires --experimental-sqlite (node:sqlite is still experimental as
// of Node 22.x/23.x).
//
// Output: JSON to stdout. Errors go to stderr.

const path = require('path');
const sessionIndex = require('./sessionIndex');

const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(process.cwd(), '.myagent', 'sessions');
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');

function parseArgs(argv) {
  // limit stays null unless given: search defaults it to 10, --list to all.
  const out = { query: null, limit: null, kindFilter: null, stats: false, list: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a === '-n') out.limit = Number(argv[++i]) || null;
    else if (a === '--kind' || a === '-k') out.kindFilter = argv[++i] || null;
    else if (a === '--stats') out.stats = true;
    else if (a === '--list' || a === '-l') out.list = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else rest.push(a);
  }
  out.query = rest.join(' ').trim() || null;
  return out;
}

function printHelp() {
  process.stderr.write([
    'recall — TF-IDF cosine search over this project\'s memory store',
    '',
    'Usage: node --experimental-sqlite recall.js [options] <query>',
    '       node --experimental-sqlite recall.js --list [options]',
    '',
    'Options:',
    '  -n, --limit N        max hits to return (default 10; --list: all)',
    '  -k, --kind KIND      filter to one row kind (default: memory)',
    '  -l, --list           list every stored memory, newest first (no query)',
    '      --stats          print row count and exit',
    '  -h, --help           show this help',
    '',
    'Note: this is lexical-overlap search (TF-IDF), not neural semantic',
    'search — queries with no shared vocabulary with a stored note will',
    'not match it.',
    '',
  ].join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = sessionIndex.open(INDEX_DB_PATH);

  if (args.stats) {
    process.stdout.write(JSON.stringify(sessionIndex.stats(db)) + '\n');
    return;
  }
  if (args.list) {
    const memories = sessionIndex.list(db, { limit: args.limit, kindFilter: args.kindFilter });
    process.stdout.write(JSON.stringify({ memories, stats: sessionIndex.stats(db) }, null, 2) + '\n');
    return;
  }
  if (!args.query) {
    process.stderr.write('error: missing query (use --help)\n');
    process.exit(2);
  }

  const hits = await sessionIndex.search(db, args.query, {
    limit: args.limit || 10,
    kindFilter: args.kindFilter,
  });
  process.stdout.write(JSON.stringify({ hits, stats: sessionIndex.stats(db) }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`recall failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
