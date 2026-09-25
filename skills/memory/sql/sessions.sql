-- sessions table: one row per saved agent session. transcript is the
-- condensed Markdown an agent adapter produces (see
-- adapters/*/condense-transcript.js) — never the raw agent log. themes is
-- a JSON-encoded string array. memory_id points at the kind='session' row
-- in memories that makes this session findable through recall.js search.
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  themes TEXT,
  summary TEXT,
  transcript TEXT NOT NULL,
  memory_id INTEGER,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);
