# Hebbian Co-Retrieval Edges

## The technique

Hebbian learning is a 1949 neuroscience postulate (Donald Hebb, *The
Organization of Behavior*), popularly summarized as "neurons that fire
together, wire together": when two connected neurons are repeatedly
active at the same time, the connection between them strengthens. The
naive formalization is `Δw = η · x_i · x_j` — weight grows in proportion
to co-activation, using only local information (no global error signal,
no labels).

Plain Hebbian growth is unstable: nothing caps it, so correlated units
strengthen each other in a positive feedback loop and weights grow
without bound. Every practical variant (Oja's rule, BCM theory, STDP)
exists to fix this, generally by pairing growth with either
normalization or decay.

Applied to memory systems, the same shape shows up as a design pattern:
weight the edges between records by how often they're **retrieved
together**, not just by static structure or one-shot extraction — and
pair that strengthening with **decay**, so unused links fade rather than
accumulating forever. This is a genuine, citable pattern in recent
agent-memory research (e.g. graph-based memory systems that strengthen
edges on co-activation and decay them over time), not just a metaphor —
though it's worth being honest that "co-occurrence graph with decay" is
also just... a co-occurrence graph with decay; calling it "Hebbian"
doesn't change the implementation, it just names the shape.

## This repo's approach

TF-IDF search (`docs/tfidf-search.md`) answers "what matches this
query?" but has no memory of its own usage — every search starts cold.
The Hebbian edge layer adds a second, complementary structure: a graph of
which memories tend to get retrieved *together*, so the system can
answer "what's related to memory X?" independent of any query.

**Trigger.** Every call to `search()` in `scripts/sessionIndex.js`
strengthens the edge between every pair of ids it returns (not just the
top-2) — any two memories co-returned in one search are treated as
having "fired together."

**Strengthening (`scripts/hebbian.js` — `strengthen`).** Asymptotic, not
linear: each reinforcement moves the weight a fixed fraction (`0.3` by
default) of the remaining distance to a ceiling of `1`. A fresh edge
jumps to `0.3`; repeated co-retrieval approaches `1` with diminishing
increments (`0.3 → 0.51 → 0.657 → ...`) and never exceeds it. This is the
direct fix for plain Hebbian learning's unbounded-growth problem —
frequently co-retrieved pairs plateau near the ceiling instead of
climbing forever.

**Decay (`scripts/hebbian.js` — `decay`).** Standard exponential decay
with a 14-day half-life, applied lazily: whenever an edge is touched
(either reinforced or read via `relatedTo`), its weight is decayed by
elapsed time since `last_updated` before use. There's no background
sweep — decay is computed on read/write, not on a schedule.

**Storage (`scripts/edgeStore.js`, `sql/edges.sql`).** A separate `edges`
table in the same SQLite file as memories: `(memory_a, memory_b, weight,
last_updated)`, one row per unordered pair (`memory_a < memory_b`, see
`hebbian.pairs`). Pure storage — no weight math lives here, only
insert/update/fetch.

**Orchestration (`scripts/sessionIndex.js`).**
- `reinforceCoRetrieval(db, ids)` — called at the end of every `search()`;
  decays the existing edge (if any) to now, then strengthens it.
- `relatedTo(db, memoryId, opts)` — read-only lookup: decays every edge
  touching `memoryId` to the current time *for display*, without writing
  the decayed value back (so weights only change on disk via actual
  reinforcement), sorts strongest-first, and enriches each link with the
  linked memory's text.

**CLI (`scripts/related.js`).** Thin shell, same pattern as `recall.js`
and `recall-store.js` — parses `<memory-id>` and `--limit`, delegates to
`sessionIndex.relatedTo`, prints JSON.

## What this buys you (and what it doesn't)

Useful: memories that keep coming up together in searches accumulate a
real signal of association independent of any single query's wording —
so `related.js 7` can surface memory 12 even if they share no
vocabulary, as long as they've been retrieved together before. That's
something plain TF-IDF search structurally cannot do on its own.

Not magic: this is still just a weighted graph with decay — the same
shape as a co-occurrence matrix or a PageRank-style graph. The Hebbian
framing is useful mainly as a design constraint (couple strengthening
and decay as one mechanism; prefer saturating over linear growth) rather
than as a claim that anything here is a "real" biological learning rule.
