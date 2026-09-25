#!/usr/bin/env node
// graph CLI — build a single-file HTML view of the memory store: every
// memory as a node, every Hebbian co-retrieval edge as a link weighted by
// its strength. Thin shell: loads the data, derives display fields,
// writes them as graph-data.js, and copies the static viewer (viewer/
// index.html + viewer.js) next to it. Read-only on the store.
//
// Data source: the project's .myagent/sessions/index.db when it exists
// and has memories; otherwise the synthetic example store in
// examples/memories/ (memories.jsonl + edges.jsonl). --examples forces
// the examples, which is what the GitHub Pages build uses so real
// memories are never published.
//
// Requires --experimental-sqlite (node:sqlite is still experimental as
// of Node 22.x/23.x).
//
// Usage:
//   node --experimental-sqlite graph.js [--examples] [--examples-dir DIR] [--out DIR]
//
// Output: <out>/index.html and viewer.js (static, copied as-is),
// <out>/graph-data.js (sets window.MEMORY_GRAPH; a plain <script>, not a
// fetch or module import, so the page also opens from disk) and
// <out>/graph.json. Prints a JSON receipt. Errors go to stderr.

const fs = require('fs');
const path = require('path');
const { tokenize } = require('./tokenize');
const { termFrequencies, buildIdf, tfidfVector } = require('./tfidf');
const hebbian = require('./hebbian');

const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(process.cwd(), '.myagent', 'sessions');
const INDEX_DB_PATH = path.join(SESSIONS_DIR, 'index.db');
const VIEWER_DIR = path.join(__dirname, '..', 'viewer');
const VIEWER_FILES = ['index.html', 'viewer.js'];
const TOP_TERMS = 6;
// Display-only: search itself has no stopword list (see tokenize.js), but
// "for" or "the" make useless labels when a note is short.
const STOPWORDS = new Set('the and for with that this from into are was not but its their each when also only then than use via one all any can has have per'.split(' '));

function parseArgs(argv) {
  const out = {
    examples: false,
    examplesDir: path.join(process.cwd(), 'examples', 'memories'),
    out: path.join(path.dirname(SESSIONS_DIR), 'graph'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--examples') out.examples = true;
    else if (a === '--examples-dir') out.examplesDir = path.resolve(argv[++i] || '');
    else if (a === '--out' || a === '-o') out.out = path.resolve(argv[++i] || '');
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  process.stderr.write([
    'graph — build an HTML graph of memories and their Hebbian edge weights',
    '',
    'Usage: node --experimental-sqlite graph.js [options]',
    '',
    'Options:',
    '      --examples           use the example store even if index.db exists',
    '      --examples-dir DIR   example store folder (default examples/memories)',
    '  -o, --out DIR            output folder (default .myagent/graph, gitignored)',
    '  -h, --help               show this help',
    '',
  ].join('\n') + '\n');
}

// -> { memories, edges } from index.db, or null when there's no store
// with at least one memory. Checks existence first so a missing store
// isn't created as a side effect.
function loadSqlite() {
  if (!fs.existsSync(INDEX_DB_PATH)) return null;
  const store = require('./store');
  const edgeStore = require('./edgeStore');
  const db = store.open(INDEX_DB_PATH);
  const memories = store.allMemories(db);
  if (memories.length === 0) return null;
  return { memories, edges: edgeStore.allEdges(db) };
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// -> { memories, edges } from the example folder. term_freq isn't stored
// there, so it's derived from the text the same way storeMemory does.
function loadExamples(dir) {
  const memFile = path.join(dir, 'memories.jsonl');
  if (!fs.existsSync(memFile)) throw new Error(`no example store at ${dir} (memories.jsonl missing)`);
  const edgeFile = path.join(dir, 'edges.jsonl');
  return {
    memories: readJsonl(memFile).map((m) => ({ ...m, tags: m.tags || [], term_freq: termFrequencies(tokenize(m.text)) })),
    edges: fs.existsSync(edgeFile) ? readJsonl(edgeFile) : [],
  };
}

// memories -> id -> the row's highest TF-IDF terms, i.e. the words that
// most set it apart from the rest of the store.
function topTerms(memories) {
  const idf = buildIdf(memories.map((m) => m.term_freq));
  const out = new Map();
  for (const m of memories) {
    const vec = tfidfVector(m.term_freq, idf);
    out.set(m.id, Object.keys(vec).filter((t) => t.length > 2 && !STOPWORDS.has(t)).sort((a, b) => vec[b] - vec[a]).slice(0, TOP_TERMS));
  }
  return out;
}

// raw rows -> the viewer's data: memories without term_freq, edges with
// both the stored weight and the weight decayed to asOf. A live store is
// viewed as of now; the examples as of their last activity, so the demo
// doesn't fade away as real time passes.
function toGraph({ memories, edges }, source, sourcePath) {
  const latest = [...memories.map((m) => m.ts), ...edges.map((e) => e.last_updated)].sort().pop();
  const asOf = source === 'sqlite' ? new Date().toISOString() : latest;
  const terms = topTerms(memories);
  const ids = new Set(memories.map((m) => m.id));
  return {
    source,
    sourcePath,
    generatedAt: new Date().toISOString(),
    asOf,
    halfLifeDays: hebbian.DEFAULT_HALF_LIFE_MS / (24 * 60 * 60 * 1000),
    memories: memories.map(({ term_freq, ...m }) => ({ ...m, terms: terms.get(m.id) })),
    edges: edges
      .filter((e) => ids.has(e.memory_a) && ids.has(e.memory_b))
      .map((e) => ({
        a: e.memory_a,
        b: e.memory_b,
        weight: e.weight,
        decayed: hebbian.decay(e.weight, Date.parse(asOf) - Date.parse(e.last_updated)),
        lastUpdated: e.last_updated,
      })),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const live = args.examples ? null : loadSqlite();
  const graph = live
    ? toGraph(live, 'sqlite', INDEX_DB_PATH)
    : toGraph(loadExamples(args.examplesDir), 'examples', path.relative(process.cwd(), args.examplesDir) || '.');

  fs.mkdirSync(args.out, { recursive: true });
  for (const f of VIEWER_FILES) fs.copyFileSync(path.join(VIEWER_DIR, f), path.join(args.out, f));
  // "<" escaped so memory text can't form "</script>" if this is ever inlined.
  const json = JSON.stringify(graph).replace(/</g, '\\u003c');
  fs.writeFileSync(path.join(args.out, 'graph-data.js'), `window.MEMORY_GRAPH = ${json};\n`);
  fs.writeFileSync(path.join(args.out, 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
  process.stdout.write(JSON.stringify({
    ok: true, source: graph.source, memories: graph.memories.length, edges: graph.edges.length,
    out: path.join(args.out, 'index.html'),
  }) + '\n');
}

try {
  main();
} catch (err) {
  process.stderr.write(`graph failed: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
