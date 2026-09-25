# Claude Code adapter

Claude Code discovers Skills only from two fixed locations: `.claude/skills/`
(project) and `~/.claude/skills/` (user). There's no setting that points it
at an arbitrary directory, so the agent-agnostic skills in [`../../skills`](../../skills)
can't be used by Claude Code directly.

This adapter closes that gap with [`sync.ps1`](./sync.ps1), which copies
only each skill's `SKILL.md` into `.claude/skills/<name>/SKILL.md`. Nothing
else is duplicated: supporting folders such as `scripts/` stay in
`skills/<name>/` and are referenced from `SKILL.md` via a `{{SKILL_ROOT}}`
token, which the sync script rewrites to a relative path
(`../../../skills/<name>`) as it copies. `skills/` stays the single source
of truth for everything except this one generated, rewritten file.

Windows symlinks were considered instead (zero drift, edits show up
immediately) but rejected: they require Developer Mode or admin privileges
and are fragile across tools and git, so a plain copy script is simpler and
more portable.

## Usage

From the repo root:

```powershell
# Sync all skills
./adapters/claude-code/sync.ps1

# Sync just one skill
./adapters/claude-code/sync.ps1 -Skill file-to-template

# Preview without writing anything
./adapters/claude-code/sync.ps1 -WhatIf
```

Re-run after editing any skill's `SKILL.md` — `.claude/skills/` is not kept
in sync automatically. Editing a skill's `scripts/` (or other supporting
folder) needs no re-sync, since `.claude/skills/<name>/SKILL.md` reads
those files from `skills/<name>/` directly at runtime.

## Session memory

The memory skill can save a whole session (see "Save a session" in
[`skills/memory/SKILL.md`](../../skills/memory/SKILL.md)). Everything in
that skill is agent-agnostic except two things only Claude Code knows,
which live here:

- [`record-session-hook.js`](./record-session-hook.js) — a `SessionStart`
  and `UserPromptSubmit` hook (registered in `.claude/settings.json`) that
  writes the current `session_id` and `transcript_path` to
  `.myagent/sessions/current.json`.
- [`condense-transcript.js`](./condense-transcript.js) — reads Claude
  Code's `.jsonl` session log (the one in `current.json`, or a path given
  as its argument) and prints the condensed Markdown that
  `save-session.js` stores: user messages and assistant replies in full,
  one line per tool call and per failed tool result, and nothing else. A
  typical session shrinks to 1–2% of the raw log.

For raw saves (`save-session.js --raw`) the skill archives the file at
`transcript_path` as-is, so no extra adapter code is needed: the raw
archive is whatever format the agent writes.

An adapter for another agent needs its own versions of these two: a way
to record its current session into `current.json`, and a condenser that
emits the same Markdown shape (`## User` / `## Assistant` sections, with
`  · [Tool] …` lines under them).

## Notes

- A skill directory without a `SKILL.md` is skipped with a warning.
- `.claude/skills/<name>/SKILL.md` is fully regenerated on each sync, so
  don't hand-edit it directly — edit `skills/<name>/SKILL.md` and re-sync.
- `.claude/skills/<name>/SKILL.md` only works when it stays inside this
  repo at its expected depth (`.claude/skills/<name>/`), since
  `{{SKILL_ROOT}}` is rewritten to a path relative to that location.
