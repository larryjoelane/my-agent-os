// Single responsibility: own the node:sqlite `sessions` table — schema,
// upsert, fetch. No transcript parsing (that's an agent adapter's job)
// and no memories-row bookkeeping (sessionIndex.js wires that up).
//
// Shares the same DatabaseSync connection as store.js (one db file,
// several tables) — callers pass in the already-open db from store.open().

const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'sql', 'sessions.sql'), 'utf8');

// Ensures the sessions table exists. Idempotent, safe to call every open().
function ensureSchema(db) {
  db.exec(SCHEMA);
}

// row -> row with themes parsed back into an array.
function parseRow(row) {
  return { ...row, themes: row.themes ? JSON.parse(row.themes) : [] };
}

// Insert or overwrite a session by session_id. created_ts survives an
// overwrite, so re-saving a session mid-way and again at the end keeps
// when it was first saved.
function putSession(db, { sessionId, name, themes, summary, transcript, memoryId, ts }) {
  db.prepare(`
    INSERT INTO sessions (session_id, name, themes, summary, transcript, memory_id, created_ts, updated_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET
      name = excluded.name,
      themes = excluded.themes,
      summary = excluded.summary,
      transcript = excluded.transcript,
      memory_id = excluded.memory_id,
      updated_ts = excluded.updated_ts
  `).run(
    sessionId,
    name,
    themes && themes.length ? JSON.stringify(themes) : null,
    summary || null,
    transcript,
    memoryId,
    ts,
    ts,
  );
}

// sessionId -> row | undefined.
function getSession(db, sessionId) {
  const row = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId);
  return row ? parseRow(row) : undefined;
}

// name -> most recently updated row with that exact name | undefined.
function getSessionByName(db, name) {
  const row = db.prepare(
    'SELECT * FROM sessions WHERE name = ? ORDER BY updated_ts DESC LIMIT 1'
  ).get(name);
  return row ? parseRow(row) : undefined;
}

// -> every session without its transcript, newest first. Transcripts are
// left out so a listing stays small; fetch one with getSession.
function listSessions(db) {
  return db.prepare(`
    SELECT session_id, name, themes, summary, memory_id, created_ts, updated_ts,
           length(transcript) AS transcript_chars
    FROM sessions ORDER BY updated_ts DESC
  `).all().map(parseRow);
}

module.exports = { ensureSchema, putSession, getSession, getSessionByName, listSessions };
