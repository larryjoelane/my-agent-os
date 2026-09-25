# TF-IDF Cosine Search

## The technique

TF-IDF (term frequency–inverse document frequency) is a classic
information-retrieval scoring method, predating neural embeddings by
decades. It scores how relevant a document is to a query using only word
overlap, weighted so that rare, distinctive words count for more than
common ones:

- **Term frequency (TF)** — how many times a word appears in a document.
  More occurrences of a query word in a document suggest more relevance.
- **Inverse document frequency (IDF)** — how rare a word is across the
  whole corpus. A word that appears in nearly every document (e.g. "the",
  "user") carries little discriminative power and gets a low weight; a
  word that appears in only a handful of documents gets a high weight.
- Each document (and the query) becomes a sparse vector of `word ->
  TF * IDF` weights, and relevance is the **cosine similarity** between
  the query vector and each document vector — the cosine of the angle
  between them, in `[0, 1]` for non-negative weights.

It is **lexical-overlap search, not semantic search**: there is no
stemming and no synonym awareness, so "deploy" will not match
"deployment", and "editor preferences" will not match "tabs over spaces"
with zero shared vocabulary. What it buys you over naive keyword
matching is that shared *rare* words matter more than shared *common*
words — searching "kubernetes rollback" will weight a match on
"kubernetes" far higher than a match on "the" or "and".

There is no BM25, no FTS5, and no neural embedding model involved.
Scoring pipeline at search time: tokenize the query the same way as
stored notes → build corpus-wide IDF → vectorize query and every stored
note → cosine similarity → drop zero-score hits → sort descending → slice
to the requested limit.

Storage is Node's built-in `node:sqlite` (`DatabaseSync`) — no native
module to install, but still an **experimental API** as of Node
22.5–23.x, so every invocation needs the `--experimental-sqlite` flag.

## This repo's approach

Implemented as a small pipeline of pure functions, each doing exactly one
step, wired together by `scripts/sessionIndex.js`:

1. `scripts/tokenize.js` — `tokenize(text)`: lowercase, strip
   non-alphanumerics, split on whitespace. No stemming, no stopword list
   — IDF already discounts common words, so a stopword list would be
   redundant complexity.
2. `scripts/tfidf.js` — four pure functions with no I/O:
   - `termFrequencies(tokens)` → `{ term: count }`
   - `buildIdf(termFreqMaps)` → `{ term: idf }`, computed fresh over the
     whole corpus at search time (smoothed: `log((1+N)/(1+df)) + 1`)
   - `tfidfVector(termFreqs, idf)` → sparse `{ term: weight }`
   - `cosineSimilarity(a, b)` → score in `[0, 1]`
3. `scripts/store.js` — persists only the raw term-frequency map per
   memory (as JSON in SQLite). The TF-IDF vector itself is **not** stored
   — it's derived at search time against the current corpus, since IDF
   depends on every row and would go stale the moment a new memory is
   added.
4. `scripts/sessionIndex.js` — `search(db, query, opts)` orchestrates:
   load all rows → build corpus IDF → vectorize the query → score every
   row → filter zero-score rows → sort → slice to `limit`.

Each module is independently testable and has no knowledge of the others'
internals — `tfidf.js` doesn't know about SQLite, `store.js` doesn't know
about cosine similarity, and `tokenize.js` doesn't know either exists.

See `SKILL.md` for the CLI usage (`recall.js`).
