// Single responsibility: own the node:sqlite `edges` table — schema,
// upsert-with-decay, fetch. No Hebbian math here (see hebbian.js), no
// tokenizing or TF-IDF; this module only persists edge rows.
//
// Shares the same DatabaseSync connection as store.js (one db file, two
// tables) — callers pass in the already-open db from store.open().

const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'edges.sql'), 'utf8');

// Ensures the edges table exists. Called alongside store's schema setup;
// idempotent, safe to call every open().
function ensureSchema(db) {
  db.exec(SCHEMA);
}

// (db, memoryA, memoryB) -> row | undefined. memoryA/memoryB must already
// be ordered a < b (see hebbian.pairs) — this table stores each pair once.
function getEdge(db, memoryA, memoryB) {
  return db.prepare(
    'SELECT * FROM edges WHERE memory_a = ? AND memory_b = ?'
  ).get(memoryA, memoryB);
}

// Insert or overwrite an edge's weight/timestamp. Callers compute the new
// weight (via hebbian.strengthen/decay) before calling this — this
// function only persists, it doesn't do the math.
function putEdge(db, memoryA, memoryB, weight, ts) {
  db.prepare(`
    INSERT INTO edges (memory_a, memory_b, weight, last_updated)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (memory_a, memory_b)
    DO UPDATE SET weight = excluded.weight, last_updated = excluded.last_updated
  `).run(memoryA, memoryB, weight, ts);
}

// (db, memoryId) -> all edges touching memoryId, either side.
function edgesFor(db, memoryId) {
  return db.prepare(
    'SELECT * FROM edges WHERE memory_a = ? OR memory_b = ?'
  ).all(memoryId, memoryId);
}

module.exports = { ensureSchema, getEdge, putEdge, edgesFor };
