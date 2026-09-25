-- edges table: Hebbian-style co-retrieval graph between memories. See
-- docs/hebbian-edges.md for the approach; scripts/hebbian.js for the
-- weight math; scripts/edgeStore.js for the queries against this table.
--
-- One row per unordered pair (memory_a < memory_b, enforced by callers
-- via hebbian.pairs), so a pair is stored once regardless of which side
-- was queried.
CREATE TABLE IF NOT EXISTS edges (
  memory_a INTEGER NOT NULL,
  memory_b INTEGER NOT NULL,
  weight REAL NOT NULL DEFAULT 0,
  last_updated TEXT NOT NULL,
  PRIMARY KEY (memory_a, memory_b)
);
