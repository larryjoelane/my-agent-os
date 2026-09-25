// Single responsibility: orchestrate storage + scoring into the
// operations the CLIs need (storeMemory, search, storeSession, ...). Delegates every
// sub-step to a single-purpose module — this file wires them together,
// it doesn't implement tokenizing, TF-IDF math, or row storage itself.

const { tokenize } = require('./tokenize');
const { termFrequencies, buildIdf, tfidfVector, cosineSimilarity } = require('./tfidf');
const store = require('./store');
const edgeStore = require('./edgeStore');
const sessionStore = require('./sessionStore');
const rawArchive = require('./rawArchive');
const hebbian = require('./hebbian');

// Write one freeform memory. Only stores raw term frequencies — the
// TF-IDF vector itself is derived at search time against the current
// corpus (see scoreAgainstQuery), since IDF changes as rows are added.
async function storeMemory(db, { text, source = 'cli', tags = null, kind = 'memory', ts = null }) {
  const termFreq = termFrequencies(tokenize(text));
  const id = store.insertMemory(db, { text, termFreq, source, tags, kind, ts });
  return { id, ts: ts || new Date().toISOString() };
}

// rows ({term_freq}[]) -> { term: idf }. Isolated so search() reads as a
// pipeline instead of inlining the corpus-wide step.
function idfForCorpus(rows) {
  return buildIdf(rows.map((r) => r.term_freq));
}

// (row, idf, queryVector) -> { ...row, score }. One row's similarity to
// one query — kept separate from the loop that calls it.
function scoreRow(row, idf, queryVector) {
  const docVector = tfidfVector(row.term_freq, idf);
  return { ...row, score: cosineSimilarity(queryVector, docVector) };
}

// Search all stored memories by TF-IDF cosine similarity to the query.
// Pure lexical-overlap ranking — no neural embeddings, so paraphrases
// with no shared vocabulary won't match.
async function search(db, query, { limit = 10, kindFilter = null } = {}) {
  let rows = store.allMemories(db);
  if (kindFilter) rows = rows.filter((r) => r.kind === kindFilter);
  if (rows.length === 0) return [];

  const idf = idfForCorpus(rows);
  const queryVector = tfidfVector(termFrequencies(tokenize(query)), idf);

  const hits = rows
    .map((row) => scoreRow(row, idf, queryVector))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ term_freq, ...hit }) => hit); // internal vector input, not part of the public hit shape

  reinforceCoRetrieval(db, hits.map((h) => h.id));
  return hits;
}

// session fields -> the text of its kind='session' memories row: only
// what's meant to be searched on (name, themes, summary), never the
// transcript, which would swamp TF-IDF with every word said in a session.
function sessionMemoryText({ name, themes, summary }) {
  return [
    `Session: ${name}`,
    themes && themes.length ? `Themes: ${themes.join(', ')}` : null,
    summary || null,
  ].filter(Boolean).join('\n');
}

// Save (or re-save) one session: the full condensed transcript goes in
// the sessions table, and a searchable summary row goes in memories so
// recall.js finds it. Re-saving the same sessionId updates both rows in
// place rather than adding duplicates. With raw = { sessionsDir,
// sourcePath }, the agent's native log is also archived byte-for-byte.
function storeSession(db, { sessionId, name, themes = [], summary = null, transcript, raw = null }) {
  const ts = new Date().toISOString();
  const archived = raw ? rawArchive.archive(raw.sessionsDir, sessionId, raw.sourcePath) : null;
  const text = sessionMemoryText({ name, themes, summary });
  const memoryRow = { text, termFreq: termFrequencies(tokenize(text)), source: `session:${sessionId}`, tags: themes, kind: 'session', ts };

  const existing = sessionStore.getSession(db, sessionId);
  let memoryId = existing && existing.memory_id;
  if (memoryId && store.getMemory(db, memoryId)) store.updateMemory(db, memoryId, memoryRow);
  else memoryId = store.insertMemory(db, memoryRow);

  sessionStore.putSession(db, {
    sessionId, name, themes, summary, transcript, memoryId,
    rawPath: archived && archived.rawPath, rawBytes: archived && archived.rawBytes, ts,
  });
  return { sessionId, name, memoryId, updated: Boolean(existing), ts, ...(archived || {}) };
}

// session id or exact name -> full session row (with transcript) | undefined.
function getSession(db, idOrName) {
  return sessionStore.getSession(db, idOrName) || sessionStore.getSessionByName(db, idOrName);
}

// session row -> the original raw log's bytes | null when it was never
// saved raw.
function getRawLog(sessionsDir, session) {
  return session.raw_path ? rawArchive.restore(sessionsDir, session.raw_path) : null;
}

// Every saved session, newest first, with each raw archive extracted to a
// plain file alongside: adds raw_extracted_path, or raw_extract_error when
// that one archive can't be restored (the rest of the list still returns).
function listSessionsExtracted(db, sessionsDir) {
  return sessionStore.listSessions(db).map((s) => {
    if (!s.raw_path) return s;
    try {
      return { ...s, raw_extracted_path: rawArchive.extract(sessionsDir, s.raw_path).path };
    } catch (err) {
      return { ...s, raw_extract_error: err.message };
    }
  });
}

// Every stored memory, newest first, in the same shape as a search hit
// minus score. Unlike search, this is read-only: listing isn't
// co-retrieval, so it never touches edges.
function list(db, { limit = null, kindFilter = null } = {}) {
  let rows = store.allMemories(db);
  if (kindFilter) rows = rows.filter((r) => r.kind === kindFilter);
  rows = rows
    .sort((a, b) => (b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : b.id - a.id))
    .map(({ term_freq, ...row }) => row);
  return limit ? rows.slice(0, limit) : rows;
}

// Strengthen the edge between every pair of ids returned together in one
// search ("fire together, wire together" — see docs/hebbian-edges.md).
// A no-op below two hits, since there's no pair to link.
function reinforceCoRetrieval(db, ids) {
  if (ids.length < 2) return;
  const now = new Date().toISOString();
  for (const [a, b] of hebbian.pairs(ids)) {
    const existing = edgeStore.getEdge(db, a, b);
    const decayed = existing
      ? hebbian.decay(existing.weight, Date.parse(now) - Date.parse(existing.last_updated))
      : 0;
    edgeStore.putEdge(db, a, b, hebbian.strengthen(decayed), now);
  }
}

// (edge, memoryId) -> { memoryId, weight, lastUpdated } for the *other*
// side of the edge. Isolated so relatedTo's map callback reads as one step.
function otherSide(edge, memoryId, weight) {
  return {
    memoryId: edge.memory_a === memoryId ? edge.memory_b : edge.memory_a,
    weight,
    lastUpdated: edge.last_updated,
  };
}

// memoryId -> linked memories, decayed to now, sorted strongest first,
// enriched with each linked memory's text. Read-only: applies decay for
// display without writing it back, so weights only change on disk via
// reinforcement (see reinforceCoRetrieval).
function relatedTo(db, memoryId, { limit = 10 } = {}) {
  const now = Date.now();
  return edgeStore.edgesFor(db, memoryId)
    .map((edge) => otherSide(edge, memoryId, hebbian.decay(edge.weight, now - Date.parse(edge.last_updated))))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map((link) => {
      const memory = store.getMemory(db, link.memoryId);
      return { ...link, text: memory ? memory.text : null };
    });
}

function stats(db) {
  return { rows: store.countMemories(db) };
}

module.exports = {
  open: store.open, storeMemory, search, list, relatedTo, stats,
  storeSession, getSession, getRawLog, listSessions: sessionStore.listSessions, listSessionsExtracted,
};
