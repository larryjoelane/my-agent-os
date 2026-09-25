-- memories table: one row per stored note. term_freq is a JSON-encoded
-- { term: count } map; the TF-IDF vector itself is derived at search
-- time against the whole corpus (see scripts/sessionIndex.js), since IDF
-- depends on every row and would go stale if baked in at insert time.
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  term_freq TEXT NOT NULL,
  source TEXT,
  tags TEXT,
  kind TEXT,
  ts TEXT NOT NULL
);
