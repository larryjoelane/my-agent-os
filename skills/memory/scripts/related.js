#!/usr/bin/env node
// related CLI — look up memories strongly linked to a given memory id via
// the Hebbian co-retrieval graph (see docs/hebbian-edges.md). Thin shell:
// arg parsing and stdout/stderr only, all real work delegates to
// sessionIndex.js.
//
// Requires --experimental-sqlite (node:sqlite is still experimental as
// of Node 22.x/23.x).
//
// Usage:
//   node --experimental-sqlite related.js <memory-id> [--limit N]
//
// Output: JSON to stdout. Errors go to stderr.

const path = require('path');
const sessionIndex = require('./sessionIndex');

const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(process.cwd(), '.myagent', 'sessions');
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');

function parseArgs(argv) {
  const out = { id: null, limit: 10 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' || a === '-n') out.limit = Number(argv[++i]) || 10;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (out.id === null) out.id = Number(a);
  }
  return out;
}

function printHelp() {
  process.stderr.write([
    'related — memories linked to a given memory via co-retrieval strength',
    '',
    'Usage: node --experimental-sqlite related.js <memory-id> [options]',
    '',
    'Options:',
    '  -n, --limit N        max links to return (default 10)',
    '  -h, --help           show this help',
    '',
    'Edge weight grows each time two memories are returned together in a',
    'search (saturating growth, see scripts/hebbian.js) and decays over',
    'time when unused. See docs/hebbian-edges.md for the approach.',
    '',
  ].join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id || Number.isNaN(args.id)) {
    process.stderr.write('error: missing or invalid <memory-id> (use --help)\n');
    process.exit(2);
  }

  const db = sessionIndex.open(INDEX_DB_PATH);
  const links = sessionIndex.relatedTo(db, args.id, { limit: args.limit });
  process.stdout.write(JSON.stringify({ id: args.id, links }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`related failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
