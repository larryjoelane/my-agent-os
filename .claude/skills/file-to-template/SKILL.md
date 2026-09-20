---
name: file-to-template
description: Turn a file into a reusable {{VAR}} template. Use when the user wants to extract a config, script, or doc into a template with placeholders for values that should change per use (hosts, ports, emails, URLs, paths, credentials, IDs, etc). Auto-detects likely variables and reports every substitution; also accepts explicit name=value overrides for exact control.
---

# File to Template

Convert an existing file into a reusable template by replacing concrete
values with `{{VAR_NAME}}` placeholders, so the file can be re-filled for a
new environment, project, or user later.

This skill is implemented as a standalone Node.js script, kept separate
from these instructions: `../../../skills/file-to-template/scripts/templatize.js`. Nothing
about the logic lives in this file â€” always invoke the script rather than
re-implementing its behavior inline.

`../../../skills/file-to-template` is a token resolved by each agent adapter to wherever this
skill's directory actually lives for that agent (see `adapters/*/README.md`
in the repo root). It is not a literal path â€” don't run commands against
the string `../../../skills/file-to-template` itself.

## Requirements

- Node.js must be available on PATH (`node --version`). No npm packages
  are required â€” the script has zero dependencies.

## How it works

Two replacement modes, which combine in one run:

1. **Explicit overrides** (`--var NAME=value`) â€” force one exact literal
   value in the file to become `{{NAME}}`. Always applied first, and
   always wins: auto-detection will never re-touch text that's already
   been turned into a placeholder.
2. **Auto-detect** (on by default) â€” heuristically finds values that are
   likely meant to vary: email addresses, URLs, filesystem paths, quoted
   strings, and standalone numbers. Each match becomes a placeholder named
   after its kind (`EMAIL`, `URL`, `PATH`, `STRING`, `NUMBER`, with `_2`,
   `_3`, ... suffixes for repeats). Object/property keys (e.g. the `"host"`
   in `"host": "localhost"`) are left alone â€” only values are templated.

Every run produces two files:
- The template itself (default: `<file>.template<ext>`, e.g.
  `config.json` â†’ `config.template.json`)
- A JSON report next to it (default: `<output>.report.json`) listing every
  replacement made, so the auto-detected names can be reviewed, renamed,
  or reverted by hand.

## Usage

```
node ../../../skills/file-to-template/scripts/templatize.js <file> [options]

Options:
  --var NAME=value    Explicit replacement (repeatable). Value must be an
                       exact substring of the file's current contents.
  --out <path>        Output template path (default: <file>.template<ext>)
  --report <path>     Report JSON path (default: <out>.report.json)
  --no-auto           Disable auto-detection; only apply --var replacements
  --dry-run           Print what would happen without writing files
  --help              Show usage
```

## When to use which mode

- Use plain auto-detect for a quick first pass on a config-like file, then
  read the report and manually rename any placeholder whose auto-generated
  name (`STRING_3`, `NUMBER`) isn't meaningful.
- Use `--var` (with or without `--no-auto`) when specific values need
  specific, predictable names â€” e.g. secrets, or values auto-detect can't
  categorize well (an identifier that isn't a URL/email/path/plain number).
- Use `--no-auto --var ...` for full manual control with no heuristic
  guessing at all.
- Always run with `--dry-run` first on a file you haven't templated
  before, and read the printed report before writing real output.

## Example

```
node ../../../skills/file-to-template/scripts/templatize.js ./config.json --var HOST=localhost

# config.json:
#   { "host": "localhost", "port": 8080, "admin_email": "admin@example.com" }
#
# config.template.json:
#   { "host": "{{HOST}}", "port": {{NUMBER}}, "admin_email": "{{EMAIL}}" }
#
# config.template.json.report.json lists every replacement made.
```

## Limitations

- Heuristics are regex-based, not a real parser for any given file format
  â€” always review the report, especially for source code files where a
  "number" or "string" match might be part of syntax rather than
  configuration (e.g. an array index or a version pin).
- `--var` matches literal substrings; if the same literal value appears in
  multiple unrelated places in the file, all occurrences are replaced.
- Placeholder names must be valid identifiers (`[A-Za-z_][A-Za-z0-9_]*`).
