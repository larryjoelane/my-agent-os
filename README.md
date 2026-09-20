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
