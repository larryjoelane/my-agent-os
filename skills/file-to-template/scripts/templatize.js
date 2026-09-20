#!/usr/bin/env node
/**
 * templatize.js
 *
 * Turns a file into a reusable template by replacing values with
 * {{VAR_NAME}} placeholders.
 *
 * Modes (can be combined):
 *   1. Auto-detect (default): heuristically finds likely-variable values
 *      (quoted strings, numbers, emails, URLs, file paths) and replaces
 *      each with a generated placeholder. Prints a report of every
 *      replacement so it can be reviewed/undone by hand.
 *   2. Explicit overrides (--var NAME=value): force a specific literal
 *      value to become {{NAME}} instead of an auto-generated name.
 *      Overrides always take precedence over auto-detected names for the
 *      same literal value, and are applied first so auto-detect will not
 *      double-replace them.
 *
 * Usage:
 *   node templatize.js <file> [options]
 *
 * Options:
 *   --var NAME=value       Explicit replacement (repeatable).
 *   --out <path>           Output template path (default: <file>.template<ext>).
 *   --report <path>        Report JSON path (default: <out>.report.json).
 *   --no-auto              Disable auto-detection; only --var replacements are applied.
 *   --dry-run              Don't write files; print what would happen.
 *   --help                 Show usage.
 *
 * Exit codes: 0 success, 1 usage error, 2 runtime error.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function printUsageAndExit(code) {
  const usage = `
Usage: node templatize.js <file> [options]

Turn a file into a {{VAR}} template. Auto-detects likely variables
(strings, numbers, emails, URLs, paths) by default; use --var to force
specific values to specific names, which always take precedence.

Options:
  --var NAME=value    Explicit replacement (repeatable)
  --out <path>        Output template path (default: <file>.template<ext>)
  --report <path>     Report JSON path (default: <out>.report.json)
  --no-auto           Disable auto-detection; only apply --var replacements
  --dry-run           Print what would happen without writing files
  --help               Show this message

Examples:
  node templatize.js ./config.json
  node templatize.js ./config.json --var PORT=8080 --var HOST=localhost
  node templatize.js ./config.json --no-auto --var API_KEY=sk-abc123
`;
  process.stdout.write(usage.trimStart() + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    file: null,
    vars: [], // { name, value } in given order
    out: null,
    report: null,
    auto: true,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      printUsageAndExit(0);
    } else if (a === '--var') {
      const next = argv[++i];
      if (!next || !next.includes('=')) {
        throw new UsageError(`--var requires NAME=value, got: ${next ?? '(missing)'}`);
      }
      const eq = next.indexOf('=');
      const name = next.slice(0, eq);
      const value = next.slice(eq + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new UsageError(`--var name must match [A-Za-z_][A-Za-z0-9_]*, got: ${name}`);
      }
      if (value === '') {
        throw new UsageError(`--var ${name}=... value must not be empty`);
      }
      args.vars.push({ name, value });
    } else if (a === '--out') {
      args.out = argv[++i];
      if (!args.out) throw new UsageError('--out requires a path');
    } else if (a === '--report') {
      args.report = argv[++i];
      if (!args.report) throw new UsageError('--report requires a path');
    } else if (a === '--no-auto') {
      args.auto = false;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a.startsWith('-')) {
      throw new UsageError(`Unknown option: ${a}`);
    } else if (!args.file) {
      args.file = a;
    } else {
      throw new UsageError(`Unexpected argument: ${a}`);
    }
  }

  if (!args.file) {
    throw new UsageError('Missing required <file> argument');
  }

  return args;
}

class UsageError extends Error {}

// --- Auto-detection heuristics -------------------------------------------
//
// Order matters: more specific patterns run before more general ones so
// e.g. an email isn't first chewed up by the generic quoted-string rule.
// Each detector returns matches as {start, end, value, kind} over the
// *remaining* (not-yet-claimed) text; we resolve overlaps by earliest-first.

const DETECTORS = [
  {
    kind: 'EMAIL',
    regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
  {
    kind: 'URL',
    regex: /\bhttps?:\/\/[^\s"'<>`]+/g,
  },
  {
    kind: 'PATH',
    // Unix-ish or Windows-ish paths with at least one separator, avoiding
    // bare single words. Requires at least 2 path segments.
    regex: /(?:[A-Za-z]:\\(?:[\w.-]+\\)+[\w.-]+|\/(?:[\w.-]+\/)+[\w.-]+)/g,
  },
  {
    kind: 'STRING',
    // Double- or single-quoted string contents (not the quotes), non-empty.
    regex: /"([^"\\]|\\.)+"|'([^'\\]|\\.)+'/g,
  },
  {
    kind: 'NUMBER',
    // Standalone integers/decimals, word-boundary delimited, not part of
    // a larger identifier (e.g. avoid matching "v2" or "id123").
    regex: /(?<![\w.])-?\d+(\.\d+)?(?![\w.])/g,
  },
];

// A quoted STRING match whose content is immediately followed (skipping
// whitespace) by a `:` is a JSON/object property *key*, not a value — keys
// are structural, not something a template consumer fills in, so they're
// never templated.
function isLikelyObjectKey(text, matchEnd) {
  let i = matchEnd;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === ':';
}

// Spans already occupied by a {{PLACEHOLDER}} (e.g. from an explicit --var
// replacement applied before auto-detect runs) must never be re-matched —
// otherwise auto-detect would wrap an existing placeholder in a new one
// and destroy the explicit replacement.
const PLACEHOLDER_RE = /\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/g;

function findPlaceholderSpans(text) {
  const spans = [];
  let m;
  const re = new RegExp(PLACEHOLDER_RE.source, PLACEHOLDER_RE.flags);
  while ((m = re.exec(text)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}

function detectCandidates(text) {
  const placeholderSpans = findPlaceholderSpans(text);
  const overlapsPlaceholder = (start, end) =>
    placeholderSpans.some((p) => start < p.end && p.start < end);

  const raw = [];
  for (const { kind, regex } of DETECTORS) {
    let m;
    const re = new RegExp(regex.source, regex.flags);
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) {
        re.lastIndex++;
        continue;
      }
      if (kind === 'STRING' && isLikelyObjectKey(text, end)) continue;
      if (overlapsPlaceholder(start, end)) continue;
      raw.push({ kind, start, end, raw: m[0] });
    }
  }

  // Prefer more specific matches (EMAIL/URL/PATH) over a generic STRING
  // that merely encloses them, and prefer longer matches generally. Sort
  // by priority first, then greedily accept non-overlapping matches in
  // that priority order; finally restore left-to-right order for output.
  const kindPriority = new Map(DETECTORS.map((d, i) => [d.kind, i]));
  const byPriority = [...raw].sort(
    (a, b) =>
      kindPriority.get(a.kind) - kindPriority.get(b.kind) ||
      a.start - b.start ||
      b.end - b.start - (a.end - a.start)
  );

  const accepted = [];
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  for (const c of byPriority) {
    if (accepted.some((a) => overlaps(a, c))) continue;
    accepted.push(c);
  }

  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

function nameForCandidate(kind, raw, counters) {
  const base = kind; // EMAIL, URL, PATH, STRING, NUMBER
  const n = (counters[base] = (counters[base] || 0) + 1);
  return n === 1 ? base : `${base}_${n}`;
}

// --- Core replacement ------------------------------------------------------

function applyExplicitVars(text, vars) {
  const replacements = [];
  let result = text;
  // Longer values first so a shorter value that happens to be a substring
  // of a longer one doesn't get replaced prematurely.
  const sorted = [...vars].sort((a, b) => b.value.length - a.value.length);
  for (const { name, value } of sorted) {
    let idx = 0;
    let count = 0;
    const placeholder = `{{${name}}}`;
    let next = result.indexOf(value, idx);
    while (next !== -1) {
      result = result.slice(0, next) + placeholder + result.slice(next + value.length);
      count++;
      idx = next + placeholder.length;
      next = result.indexOf(value, idx);
    }
    if (count === 0) {
      replacements.push({ name, value, occurrences: 0, warning: 'value not found in file' });
    } else {
      replacements.push({ name, value, occurrences: count });
    }
  }
  return { result, explicitReplacements: replacements };
}

function applyAutoDetect(text, alreadyUsedNames) {
  const counters = {};
  for (const usedName of alreadyUsedNames) {
    const m = /^([A-Z]+)(?:_(\d+))?$/.exec(usedName);
    if (m) {
      const base = m[1];
      const n = m[2] ? parseInt(m[2], 10) : 1;
      counters[base] = Math.max(counters[base] || 0, n);
    }
  }

  const candidates = detectCandidates(text);
  const autoReplacements = [];

  // Replace from the end so earlier offsets stay valid as we edit.
  let result = text;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    const name = nameForCandidate(c.kind, c.raw, counters);
    const placeholder = `{{${name}}}`;
    result = result.slice(0, c.start) + placeholder + result.slice(c.end);
    autoReplacements.push({ name, kind: c.kind, value: c.raw });
  }
  autoReplacements.reverse(); // restore original left-to-right order for the report

  return { result, autoReplacements };
}

function defaultOutPath(filePath) {
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${base}.template${ext}`;
}

function run(argv) {
  const args = parseArgs(argv);

  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) {
    throw new UsageError(`File not found: ${args.file}`);
  }
  if (!fs.statSync(filePath).isFile()) {
    throw new UsageError(`Not a file: ${args.file}`);
  }

  const original = fs.readFileSync(filePath, 'utf8');

  // 1. Explicit --var overrides are applied first (and always win).
  const { result: afterExplicit, explicitReplacements } = applyExplicitVars(original, args.vars);

  // 2. Auto-detect over what's left, unless disabled.
  let final = afterExplicit;
  let autoReplacements = [];
  if (args.auto) {
    const usedNames = explicitReplacements.map((r) => r.name);
    const autoResult = applyAutoDetect(afterExplicit, usedNames);
    final = autoResult.result;
    autoReplacements = autoResult.autoReplacements;
  }

  const outPath = path.resolve(args.out || defaultOutPath(filePath));
  const reportPath = path.resolve(args.report || `${outPath}.report.json`);

  const report = {
    source: filePath,
    output: outPath,
    generatedAt: new Date().toISOString(),
    explicitReplacements,
    autoReplacements,
    totalPlaceholders: explicitReplacements.filter((r) => r.occurrences > 0).length + autoReplacements.length,
  };

  if (args.dryRun) {
    process.stdout.write('--- DRY RUN: no files written ---\n');
    process.stdout.write(`Would write template to: ${outPath}\n`);
    process.stdout.write(`Would write report to:   ${reportPath}\n\n`);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return report;
  }

  fs.writeFileSync(outPath, final, 'utf8');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  process.stdout.write(`Template written to: ${outPath}\n`);
  process.stdout.write(`Report written to:   ${reportPath}\n`);
  process.stdout.write(`Placeholders: ${report.totalPlaceholders}\n`);

  return report;
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`Error: ${err.message}\n\n`);
      printUsageAndExit(1);
    } else {
      process.stderr.write(`Unexpected error: ${err.stack || err.message}\n`);
      process.exit(2);
    }
  }
}

module.exports = { run, parseArgs, applyExplicitVars, applyAutoDetect, detectCandidates };
