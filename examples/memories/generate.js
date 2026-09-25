#!/usr/bin/env node
// Regenerates the synthetic example store in this folder: memories.jsonl
// (notes about this repo and what each part does) and edges.jsonl (their
// Hebbian co-retrieval weights). Used by skills/memory/scripts/graph.js
// when a project has no real .myagent/sessions/index.db, and by the
// GitHub Pages build, so no one's actual memories are ever published.
//
// The edges aren't hand-written: this replays a scripted list of searches
// over the notes on a simulated clock, using the memory skill's own
// tokenize/TF-IDF/Hebbian modules, so the weights (and their decay) are
// what the real search would have produced.
//
// Usage: node examples/memories/generate.js

const fs = require('fs');
const path = require('path');
const lib = path.join(__dirname, '..', '..', 'skills', 'memory', 'scripts');
const { tokenize } = require(path.join(lib, 'tokenize'));
const { termFrequencies, buildIdf, tfidfVector, cosineSimilarity } = require(path.join(lib, 'tfidf'));
const hebbian = require(path.join(lib, 'hebbian'));

const START = Date.parse('2026-09-01T15:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const LIMIT = 4; // hits per simulated search, as an agent would pass --limit

// [day saved, kind, tags, text]
const NOTES = [
  [0, 'memory', ['layout', 'skills'], 'skills/ is the single source of truth: each skill is a directory with an agent-agnostic SKILL.md for instructions and a separate scripts/ folder for the implementation, never inlined.'],
  [0, 'memory', ['layout', 'adapters'], 'adapters/ holds one thin adapter per agent that maps the agent-agnostic skills into that agent\'s native location without duplicating implementation code.'],
  [0, 'memory', ['adapters', 'claude-code', 'sync'], 'adapters/claude-code/sync.ps1 copies each skills/<name>/SKILL.md into .claude/skills/<name>/SKILL.md and rewrites the {{SKILL_ROOT}} token to a relative path back to skills/<name>. Re-run it after editing any SKILL.md.'],
  [1, 'memory', ['skills', 'token'], 'The {{SKILL_ROOT}} token in a SKILL.md is not a literal path; each adapter resolves it to wherever the skill directory lives for that agent.'],
  [1, 'memory', ['file-to-template'], 'The file-to-template skill runs templatize.js to turn a config, script or doc into a reusable template, replacing hosts, ports, emails, URLs and paths with {{VAR}} placeholders and reporting every substitution.'],
  [2, 'memory', ['memory', 'sqlite'], 'The memory skill stores notes in .myagent/sessions/index.db using the built-in node:sqlite module: Node 22.5+ and the --experimental-sqlite flag, no npm install, no network.'],
  [2, 'memory', ['memory', 'search', 'tfidf'], 'recall.js search ranks memories by TF-IDF cosine similarity. It is lexical overlap, not semantic matching, so retry with shorter literal words before concluding there is no match.'],
  [3, 'memory', ['memory', 'tfidf'], 'tokenize.js lowercases and splits text; tfidf.js computes term frequency, smoothed IDF and cosine similarity. IDF is computed at search time because it changes as memories are added.'],
  [3, 'memory', ['memory', 'save'], 'recall-store.js saves one fact as a memory row, with optional --source and --tags, and reports the new id.'],
  [4, 'memory', ['memory', 'list'], 'recall.js --list shows every stored memory newest first. It is read-only: unlike search it never strengthens edges.'],
  [5, 'memory', ['memory', 'hebbian', 'edges'], 'Every recall.js search strengthens the Hebbian co-retrieval edge between each pair of memories returned together: fire together, wire together.'],
  [5, 'memory', ['hebbian', 'weights'], 'hebbian.js strengthen is saturating: each co-retrieval moves an edge weight 30% of the remaining distance to a ceiling of 1, so strong edges plateau instead of growing forever.'],
  [6, 'memory', ['hebbian', 'decay'], 'Hebbian edge weights decay exponentially with a 14 day half-life, so links between memories that stop being retrieved together fade instead of accumulating.'],
  [6, 'memory', ['hebbian', 'related'], 'related.js <memory-id> returns the memories most strongly linked to one memory, with edge weights decayed to now, strongest first.'],
  [8, 'memory', ['hooks', 'claude-code'], 'remember-hook.js is a UserPromptSubmit hook that injects a reminder when the user asks to remember a fact, save the whole session, or retrieve a saved session or raw log.'],
  [9, 'memory', ['hooks', 'session'], 'record-session-hook.js keeps .myagent/sessions/current.json up to date with the current Claude Code session id and transcript path.'],
  [10, 'memory', ['session', 'transcript'], 'condense-transcript.js condenses a Claude Code jsonl session log to about 1-2% of its size: every user message and reply in full, each tool call cut to one line, tool output and thinking dropped.'],
  [11, 'memory', ['session', 'save'], 'save-session.js stores the condensed transcript in the sessions table plus a kind=session memory with its name, themes and summary. Saving the same session again updates it in place.'],
  [13, 'memory', ['session', 'raw', 'gzip'], 'save-session.js --raw also archives the native session log byte-for-byte, gzipped, under .myagent/sessions/raw/ via rawArchive.js.'],
  [15, 'memory', ['session', 'raw', 'extract'], 'session.js list automatically extracts every raw gzip archive to .myagent/sessions/extracted/<session-id>.jsonl and reports raw_extracted_path; --no-extract skips it.'],
  [15, 'memory', ['session', 'raw', 'powershell'], 'Use session.js show --raw --out <file> instead of shell redirection: Windows PowerShell 5.1 re-encodes redirected output and would corrupt the raw log.'],
  [18, 'memory', ['graph', 'viewer'], 'graph.js builds a static HTML graph page (index.html, viewer.js, graph-data.js) of the memories and their Hebbian edge weights from the local sqlite store, or from the synthetic examples/memories jsonl when no store exists.'],
  [18, 'memory', ['privacy', 'git'], '.myagent/ is gitignored so real memories and session logs are never committed; the published graph page is built only from synthetic example memories.'],
  [12, 'session', ['memory skill', 'hooks', 'session storage'], 'Session memory-skill-hooks-session-saving. Themes: memory skill, hooks, session storage. Added the remember hook, session saving with condensed transcripts, and raw gzip archives of the native log.'],
  [19, 'session', ['graph', 'hebbian', 'github pages'], 'Session memory-graph-viewer. Themes: graph, hebbian, github pages. Built graph.js and the HTML viewer for memories and Hebbian edge weights, synthetic example memories, and a GitHub Pages deploy.'],
];

// [day, query] — what an agent working on this repo might have searched.
const SEARCHES = [
  [2, 'where do skills live source of truth'],
  [2, 'SKILL_ROOT token adapter path'],
  [3, 'sync.ps1 claude skills'],
  [4, 'node sqlite experimental flag'],
  [4, 'tfidf cosine search lexical'],
  [5, 'save a fact with tags'],
  [6, 'hebbian edges strengthen co-retrieval'],
  [7, 'hebbian decay half-life'],
  [7, 'edge weight ceiling saturating'],
  [8, 'related memories linked edges'],
  [9, 'hook remember save session'],
  [10, 'current session id transcript path'],
  [11, 'condense transcript session log'],
  [12, 'save session condensed transcript'],
  [13, 'hebbian edges strengthen co-retrieval'],
  [14, 'raw session log gzip archive'],
  [15, 'extract raw gzip archive session'],
  [16, 'raw log powershell redirection corrupt'],
  [16, 'save session raw log'],
  [17, 'session raw extract jsonl'],
  [18, 'graph hebbian edge weights viewer'],
  [19, 'memories never committed gitignored'],
  [19, 'graph viewer synthetic example memories'],
  [20, 'hebbian edge weights decay'],
  [20, 'session save raw gzip'],
  [21, 'tfidf search memories'],
  [22, 'graph hebbian edges memories'],
  [22, 'session raw extract jsonl'],
];

const at = (day, minutes = 0) => new Date(START + day * DAY + minutes * 60 * 1000).toISOString();

const memories = NOTES.map(([day, kind, tags, text], i) => ({
  id: i + 1, text, source: kind === 'session' ? 'save-session' : 'recall-store', tags, kind, ts: at(day, i),
  tf: termFrequencies(tokenize(text)),
}));

// Replays one search at simulated time `now`: same ranking and edge update
// as sessionIndex.search + reinforceCoRetrieval, minus the database.
const edges = new Map();
for (const [i, [day, query]] of SEARCHES.entries()) {
  const now = at(day, 60 + i);
  const visible = memories.filter((m) => m.ts <= now);
  const idf = buildIdf(visible.map((m) => m.tf));
  const q = tfidfVector(termFrequencies(tokenize(query)), idf);
  const hits = visible
    .map((m) => ({ id: m.id, score: cosineSimilarity(q, tfidfVector(m.tf, idf)) }))
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT);
  for (const [a, b] of hebbian.pairs(hits.map((h) => h.id))) {
    const key = `${a}-${b}`;
    const existing = edges.get(key);
    const decayed = existing ? hebbian.decay(existing.weight, Date.parse(now) - Date.parse(existing.last_updated)) : 0;
    edges.set(key, { memory_a: a, memory_b: b, weight: hebbian.strengthen(decayed), last_updated: now });
  }
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
fs.writeFileSync(path.join(__dirname, 'memories.jsonl'), jsonl(memories.map(({ tf, ...m }) => m)));
fs.writeFileSync(path.join(__dirname, 'edges.jsonl'), jsonl([...edges.values()].sort((x, y) => x.memory_a - y.memory_a || x.memory_b - y.memory_b)));
process.stdout.write(JSON.stringify({ ok: true, memories: memories.length, edges: edges.size }) + '\n');
