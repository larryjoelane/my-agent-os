---
name: memory
description: TF-IDF cosine search and save over a project's own memory store. Use "recall" to search prior saved notes ("we talked about X", "last time", "have we done this before"); use "list" to show every stored note ("what have we remembered", "show all memories"); use "save session" to store the whole conversation under a themed name ("save this session") and "show session" to read one back; use "save" when the user shares a preference, decision, or non-obvious fact worth remembering, or explicitly says "save this" / "remember this". Skip search when the user says to ignore history or the task is self-contained; skip save for ephemeral state or anything derivable from the codebase.
---

# memory

Implemented as standalone Node.js scripts under `{{SKILL_ROOT}}/scripts/`
— always invoke them rather than re-implementing their behavior inline.
How each technique works is documented separately in
`{{SKILL_ROOT}}/docs/` (`tfidf-search.md`, `hebbian-edges.md`); this file
only covers what's needed to call the scripts correctly.

`{{SKILL_ROOT}}` is a token resolved by each agent adapter to wherever
this skill's directory actually lives for that agent (see
`adapters/*/README.md` in the repo root). It is not a literal path — don't
run commands against the string `{{SKILL_ROOT}}` itself.

## Requirements

- Node.js on PATH, version 22.5+.
- Every command needs the `--experimental-sqlite` flag. `--no-warnings`
  is optional and only silences a stderr notice — it has no effect on
  stdout JSON.
- Nothing else. No `npm install`, no network access.

## Where memory lives

All scripts read/write `.myagent/sessions/index.db` under the current
project (override with `MYAGENT_SESSIONS_DIR`). A fresh project gets an
empty store on first save; search on an empty or missing store returns
zero hits, not an error.

## Search

```
node --experimental-sqlite --no-warnings {{SKILL_ROOT}}/scripts/recall.js "<query>" [--limit N] [--kind <kind>] [--stats]
```

- `--limit N` (`-n`) — max hits (default 10).
- `--kind <kind>` (`-k`) — narrow to one row kind (default `memory`).
- `--stats` — print row count only, no search.

Returns JSON on stdout — `hits[]` with `id`, `text`, `source`, `tags`,
`kind`, `ts`, `score` — plus a `stats` block. Errors go to stderr. Every
search also strengthens the co-retrieval edge between each pair of
returned hits as a side effect (see `docs/hebbian-edges.md`).

**Workflow:** use a focused query with words likely to appear verbatim in
the note (this is lexical overlap, not semantic matching). If a query
returns nothing, retry with a shorter, more literal variant before
concluding there's no match. Cite by timestamp, not row id.

**Output policy:** return ONLY the raw JSON by default — no prose
summary, no paraphrase. Summarize only when the user explicitly asks
("summarize", "tldr") or the search was itself part of a larger question
they asked.

## List all memories

```
node --experimental-sqlite --no-warnings {{SKILL_ROOT}}/scripts/recall.js --list [--limit N] [--kind <kind>]
```

Use when the user wants to see everything stored ("show me what we've
remembered") rather than search for something. Returns `{ memories[],
stats }`, newest first, each with `id`, `text`, `source`, `tags`, `kind`,
`ts` (no `score`). Returns every row unless `--limit` is given. Read-only:
unlike search, it never strengthens edges. Same output policy as search.

## Save a session

Use when the user asks to save the whole session or conversation (not
just one fact). Two steps: the agent adapter condenses the agent's own
log into Markdown, and `save-session.js` stores it.

1. From what the session covered, pick a short kebab-case `--name` built
   from its main theme(s), 2–4 `--themes`, and a 2–4 sentence `--summary`
   (what was built or decided, and what's left open).
2. Pipe the adapter's condensed transcript into `save-session.js`. For
   Claude Code, from the repo root:

```
node adapters/claude-code/condense-transcript.js | node --experimental-sqlite --no-warnings {{SKILL_ROOT}}/scripts/save-session.js --name "<name>" --themes a,b,c --summary "<summary>"
```

The session id comes from `.myagent/sessions/current.json`, which the
adapter's session hook keeps up to date (override with `--session-id`).
The condensed transcript keeps every user message and assistant reply in
full, cuts each tool call to one line, and drops tool output, thinking and
code changes.

Returns `{ ok, sessionId, name, memoryId, updated, ts, transcriptChars }`.
Saving the same session again (e.g. mid-way, then at the end) updates it
in place — `updated: true` — rather than adding a duplicate. The name,
themes and summary are also stored as a `kind: session` memory, so
`recall.js` searches and `--list --kind session` find saved sessions.

**Raw saves:** when the user asks for the raw or full log ("save this raw
session"), add `--raw`. The condensed transcript is still stored as
above, and the agent's native log (the `transcript_path` in
`current.json`, or `--raw-path <file>`) is also archived byte-for-byte,
gzipped, under `.myagent/sessions/raw/`. The result then also has
`rawPath`, `rawBytes` (uncompressed) and `storedBytes`. A later re-save
without `--raw` keeps the earlier archive; one with `--raw` replaces it
with the longer log.

**Output policy:** report the session name and id back plainly, plus
the raw log's size for a raw save.

## Retrieve a session

```
node --experimental-sqlite --no-warnings {{SKILL_ROOT}}/scripts/session.js list [--no-extract]
node --experimental-sqlite --no-warnings {{SKILL_ROOT}}/scripts/session.js show <session-id|name> [--json | --raw] [--out <file>]
```

`list` returns `{ sessions[] }`, newest first, without transcripts (with
`transcript_chars` instead, and `raw_path`/`raw_bytes` for raw saves).
For every raw save, `list` also extracts the archive automatically to a
plain `.myagent/sessions/extracted/<session-id>.jsonl` and reports its
absolute path as `raw_extracted_path` (or `raw_extract_error` if that
archive couldn't be restored). An extracted copy that is already newer
than its archive is reused, not rewritten. `--no-extract` skips this.
When listing, report each `raw_extracted_path` to the user; don't read
the file into context.
`show` prints one session as Markdown — a header with name, id, themes
and summary, then the transcript — ready to read back into a new
session; `--json` prints the full row instead. `--raw` restores the
original native log byte-for-byte: archives are gzipped (`.gz`), and
`show --raw` detects that and decompresses, so never read or copy the
`.gz` file directly. The log is large, so write it with
`--out <file>.jsonl` (which prints a JSON receipt with the path and size)
rather than reading it into context. Use `--out`, not shell `>`
redirection, since some shells (Windows PowerShell 5.1) re-encode
redirected output and would corrupt the log. To
find a session by topic rather than name, search with
`recall.js "<query>" --kind session`.

## Graph view

```
node --experimental-sqlite --no-warnings {{SKILL_ROOT}}/scripts/graph.js [--examples] [--examples-dir DIR] [--out DIR]
```

Builds a static page that draws every memory as a node and every Hebbian
co-retrieval edge as a link weighted by its strength. The page has search,
a min-weight filter, a stored/decayed toggle and an edge table. Uses the
project's `index.db` when it has memories; otherwise the synthetic
example store in `examples/memories/` (`--examples` forces it). Writes
`index.html` and `viewer.js` (copied from `{{SKILL_ROOT}}/viewer/`),
`graph-data.js` and `graph.json` to `--out` (default `.myagent/graph/`,
gitignored); open `index.html` directly from disk. Read-only on the
store. Returns `{ ok, source, memories, edges, out }`.

Never pass `--out` pointing at a tracked folder without `--examples`: that
would put the user's real memories in the repo. Report `out` and
`source` back plainly.

## Related memories

```
node --experimental-sqlite --no-warnings {{SKILL_ROOT}}/scripts/related.js <memory-id> [--limit N]
```

- `--limit N` (`-n`) — max links to return (default 10).

Returns `{ id, links[] }` where each link has `memoryId`, `weight`,
`lastUpdated`, `text`. Use after a `recall.js` hit when the user wants
what else is associated with a specific memory, beyond what a fresh query
would surface.

## Save

```
node --experimental-sqlite --no-warnings {{SKILL_ROOT}}/scripts/recall-store.js [--source <name>] [--tags a,b,c] "<text to remember>"
```

Text may also be piped via stdin instead of passed as an argument.

- `--source <name>` (`-s`) — label the note's origin (default `cli`).
- `--tags a,b,c` (`-t`) — comma-separated tags, if the user supplied
  categories.

**Output policy:** report the returned id back to the user plainly (e.g.
"Saved — id 3"). On error, surface the stderr message rather than
retrying with altered text.

## Don't use when

- The user asked you to work fresh or ignore prior sessions (skip search).
- The task is a routine edit with no historical dependency (skip search).
- The fact is ephemeral state or already derivable from the codebase
  (skip save).
