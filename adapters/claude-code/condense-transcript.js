#!/usr/bin/env node
// condense-transcript — turn a Claude Code session log (.jsonl) into the
// condensed Markdown that skills/memory/scripts/save-session.js stores.
// This is the only place that knows Claude Code's log format; other agent
// adapters produce the same Markdown shape from their own logs.
//
// Kept: the user's messages and the assistant's replies, in full.
// Reduced to one line: each tool call ("· [Bash] <description>"), each
// failed tool result ("↳ error: <first line>"), each hook-injected context.
// Dropped: tool output, thinking, injected skill/system text (isMeta),
// sidechain (subagent) records, and log bookkeeping (snapshots, modes,
// costs, titles). Code changes are dropped too — git has those.
//
// Usage:
//   node condense-transcript.js [transcript.jsonl]
// With no path, reads transcript_path from .myagent/sessions/current.json
// (written by record-session-hook.js). Output: Markdown to stdout.

const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = process.env.MYAGENT_SESSIONS_DIR
  || path.join(process.cwd(), '.myagent', 'sessions');
const CURRENT_SESSION_PATH = path.join(SESSIONS_DIR, 'current.json');

const MAX_TOOL_LINE = 120;
const MAX_ERROR_LINE = 160;

// text -> its first line, trimmed and capped at max chars.
function firstLine(text, max) {
  const line = String(text || '').trim().split('\n')[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// tool_use block -> "· [Tool] <what it did>". Prefers the tool's own
// description, then whichever input names its target.
function toolLine(block) {
  const input = block.input || {};
  const what = input.description || input.file_path || input.path || input.pattern
    || input.skill || input.query || input.url || input.prompt || '';
  return `  · [${block.name}] ${firstLine(what, MAX_TOOL_LINE)}`.trimEnd();
}

// tool_result content (string or block array) -> plain text.
function resultText(content) {
  if (Array.isArray(content)) return content.map((b) => b.text || '').join(' ');
  return String(content || '');
}

// A typed prompt -> what the user actually typed. Slash commands arrive
// wrapped in <command-name>/<command-args> tags; unwrap them to "/name args".
function userPromptText(text) {
  const cmd = text.match(/<command-name>([\s\S]*?)<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
  return cmd ? `${cmd[1].trim()} ${cmd[2].trim()}`.trim() : text.trim();
}

// user record -> Markdown lines.
function userLines(record) {
  if (record.isMeta) return []; // injected skill bodies, caveats — not typed by the user
  const content = record.message && record.message.content;
  if (typeof content === 'string') {
    if (content.includes('<local-command-stdout>')) return [];
    return [`\n## User\n${userPromptText(content)}`];
  }
  const lines = [];
  for (const block of content || []) {
    if (block.type === 'text' && block.text.trim()) lines.push(`\n## User\n${userPromptText(block.text)}`);
    else if (block.type === 'tool_result' && block.is_error) {
      lines.push(`    ↳ error: ${firstLine(resultText(block.content), MAX_ERROR_LINE)}`);
    }
  }
  return lines;
}

// assistant record -> Markdown lines. Thinking blocks are skipped.
function assistantLines(record) {
  const lines = [];
  for (const block of (record.message && record.message.content) || []) {
    if (block.type === 'text' && block.text.trim()) lines.push(`\n## Assistant\n${block.text.trim()}`);
    else if (block.type === 'tool_use') lines.push(toolLine(block));
  }
  return lines;
}

// attachment record -> Markdown lines. Only hook-injected context is kept.
function attachmentLines(record) {
  const a = record.attachment || {};
  if (a.type !== 'hook_additional_context') return [];
  const text = Array.isArray(a.content) ? a.content.join(' ') : a.content;
  return [`  · [hook ${a.hookEvent || a.hookName || ''}] ${firstLine(text, MAX_TOOL_LINE)}`];
}

// jsonl text -> condensed Markdown.
function condense(jsonl) {
  const lines = [];
  for (const raw of jsonl.split('\n')) {
    if (!raw.trim()) continue;
    let record;
    try { record = JSON.parse(raw); } catch { continue; } // tolerate a partially written last line
    if (record.isSidechain) continue;
    if (record.type === 'user') lines.push(...userLines(record));
    else if (record.type === 'assistant') lines.push(...assistantLines(record));
    else if (record.type === 'attachment') lines.push(...attachmentLines(record));
  }
  return lines.join('\n').trim() + '\n';
}

// -> transcript path from argv, else from current.json.
function transcriptPath() {
  if (process.argv[2]) return process.argv[2];
  try {
    return JSON.parse(fs.readFileSync(CURRENT_SESSION_PATH, 'utf8')).transcript_path || null;
  } catch {
    return null;
  }
}

function main() {
  const file = transcriptPath();
  if (!file) {
    process.stderr.write(`error: no transcript path given and none recorded in ${CURRENT_SESSION_PATH}\n`);
    process.exit(2);
  }
  process.stdout.write(condense(fs.readFileSync(file, 'utf8')));
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stderr.write(`condense-transcript failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}

module.exports = { condense };
