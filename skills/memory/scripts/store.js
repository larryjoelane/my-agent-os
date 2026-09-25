// Single responsibility: own the node:sqlite database — schema, insert,
// fetch. No tokenizing, no TF-IDF, no cosine scoring here; that logic
// lives in tfidf.js and is orchestrated by sessionIndex.js.
//
// Uses Node's built-in `node:sqlite` (no native module to install, no
// npm dependency) — still experimental as of Node 22.x/23.x, so callers
// must run with `--experimental-sqlite`.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'memories.sql'), 'utf8');

// dbPath -> DatabaseSync, schema ensured. Creates parent dir if needed.
// Also ensures the edges (edgeStore.js) and sessions (sessionStore.js)
// tables so callers get one db file with every table ready, without
// needing to know those modules exist.
function open(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  require('./edgeStore').ensureSchema(db);
  require('./sessionStore').ensureSchema(db);
  return db;
}

// Insert one row. termFreq is a plain { term: count } object, stored as
// JSON — the sparse TF-IDF vector is recomputed at search time (see
// sessionIndex.js), since IDF depends on the whole corpus and would go
// stale if baked in at insert time.
function insertMemory(db, { text, termFreq, source, tags, kind, ts }) {
  const stmt = db.prepare(`
    INSERT INTO memories (text, term_freq, source, tags, kind, ts)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    text,
    JSON.stringify(termFreq),
    source || null,
    tags && tags.length ? JSON.stringify(tags) : null,
    kind || 'memory',
    ts || new Date().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

// Overwrite one row's content in place, keeping its id — so edges that
// point at it stay valid. Same field handling as insertMemory.
function updateMemory(db, id, { text, termFreq, source, tags, kind, ts }) {
  db.prepare(`
    UPDATE memories SET text = ?, term_freq = ?, source = ?, tags = ?, kind = ?, ts = ?
    WHERE id = ?
  `).run(
    text,
    JSON.stringify(termFreq),
    source || null,
    tags && tags.length ? JSON.stringify(tags) : null,
    kind || 'memory',
    ts || new Date().toISOString(),
    id,
  );
}

// -> all rows, term_freq parsed back into an object.
function allMemories(db) {
  const rows = db.prepare('SELECT * FROM memories').all();
  return rows.map((row) => ({
    ...row,
    term_freq: JSON.parse(row.term_freq),
    tags: row.tags ? JSON.parse(row.tags) : [],
  }));
}

// -> { rows: number } — cheap counts for --stats.
function countMemories(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get();
  return Number(row.n);
}

// id -> single row (term_freq and tags parsed back into objects/arrays)
// | undefined. Mirrors allMemories' shape for one row.
function getMemory(db, id) {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!row) return undefined;
  return {
    ...row,
    term_freq: JSON.parse(row.term_freq),
    tags: row.tags ? JSON.parse(row.tags) : [],
  };
}

module.exports = { open, insertMemory, updateMemory, allMemories, countMemories, getMemory };
