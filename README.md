# my-agent-os

## Skills

Skills live under [`skills/`](./skills) in an agent-agnostic format: each
skill is a directory with a `SKILL.md` (description + instructions) and,
where needed, a separate `scripts/` (or similar) directory holding any
implementation code. Instructions and code are always kept apart — `SKILL.md`
never embeds the implementation inline, only references it, using a
`{{SKILL_ROOT}}` token in place of a literal path so the reference stays
agent-agnostic (each adapter rewrites the token to wherever the skill
actually resolves for that agent).

```
skills/
  <skill-name>/
    SKILL.md          # agent-agnostic description + instructions
    scripts/           # implementation, kept separate from SKILL.md
```

`skills/` is the single source of truth. It isn't read by any agent
directly — each agent gets its own thin **adapter** under [`adapters/`](./adapters)
that maps the agent-agnostic skills into that agent's native format/location,
without duplicating implementation code.

```
adapters/
  claude-code/
    README.md    # how the mapping works
    sync.ps1      # copies skills/<name>/SKILL.md -> .claude/skills/<name>/SKILL.md,
                    # rewriting {{SKILL_ROOT}} to a relative path back to skills/<name>/
```

### Adapters

- **Claude Code** ([`adapters/claude-code`](./adapters/claude-code)) — Claude
  Code only discovers skills from `.claude/skills/` (project) or
  `~/.claude/skills/` (user), with no config for a custom path. The adapter
  copies just each skill's `SKILL.md` into `.claude/skills/<name>/SKILL.md`;
  supporting folders like `scripts/` are referenced back in `skills/<name>/`,
  never duplicated. Run `./adapters/claude-code/sync.ps1` after editing a
  skill's `SKILL.md`.

Adding support for another agent means adding a new `adapters/<agent>/`
directory with its own mapping — `skills/` itself shouldn't need to change.

### Current skills

- [`file-to-template`](./skills/file-to-template) — turns a file into a
  reusable `{{VAR}}` template (Node.js, zero dependencies).
- [`memory`](./skills/memory) — search and save project notes via
  TF-IDF cosine similarity, stored with Node's built-in `node:sqlite`
  (zero native dependencies, zero external services).

### Memory graph page

`skills/memory/scripts/graph.js` builds a static viewer of the memory
store and its Hebbian edge weights (`viewer/index.html` + `viewer.js`,
with the data in a separate `graph-data.js` script). Locally it reads
`.myagent/sessions/index.db` if one exists and writes to the gitignored
`.myagent/graph/`:

```bash
node --experimental-sqlite --no-warnings skills/memory/scripts/graph.js
```

The GitHub Pages site (`.github/workflows/memory-graph-pages.yml`) is
built in CI with `--examples`, only from the synthetic notes in
[`examples/memories/`](./examples/memories) — regenerate those with
`node examples/memories/generate.js`. Enable it once under Settings →
Pages → Source: GitHub Actions.

### Testing a skill

Two ways to check a skill actually works:

1. **Through the agent** — once synced (see below), reference the skill
   naturally in a prompt (e.g. for `memory`: "remember that I prefer
   pnpm over npm", then later "what did I say about package managers?")
   and confirm the agent picks it up and behaves as `SKILL.md` describes.
2. **Directly, bypassing the agent** — every skill's logic lives in
   `scripts/`, callable on its own. For `memory`:

   ```bash
   node --experimental-sqlite --no-warnings skills/memory/scripts/recall-store.js "a test note"
   node --experimental-sqlite --no-warnings skills/memory/scripts/recall.js "test"
   ```

   This creates `.myagent/sessions/index.db` under whichever directory
   you run it from (gitignored) — delete that folder afterwards, or set
   `MYAGENT_SESSIONS_DIR` to point it somewhere disposable, so ad-hoc
   testing doesn't leave real project data in a test index.

   `node --version` must be 22.5+ for `memory` specifically —
   `node:sqlite` doesn't exist before that.
