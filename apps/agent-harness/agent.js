// The agent loop: send the conversation plus tool definitions to the model,
// run whatever tool calls come back, append the results, repeat until the
// model answers without calling a tool.

import { chat } from './openrouter.js';
import { toolDefs, runTool } from './tools.js';

const MAX_STEPS = 40;
const MAX_RESULT_CHARS = 30_000;

function systemPrompt(ws, sandbox) {
  const where = ws.kind === 'github'
    ? `the GitHub repository ${ws.owner}/${ws.name}, branch "${ws.branch}" (default branch "${ws.defaultBranch}")`
    : `the ${ws.label} on the user's computer`;
  const lines = [
    `You are a coding agent working in ${where}. The workspace has ${ws.paths().length} files.`,
    'Use the tools to explore and change files. Paths are relative to the workspace root and use forward slashes.',
    'Read a file before editing it. Prefer edit_file for targeted changes and write_file for new files or full rewrites.',
    sandbox
      ? 'Keep changes focused and match the existing style. Verify your work by running it in the sandbox.'
      : 'Keep changes focused and match the existing style. You cannot run code, tests or shell commands, so say what the user should verify.',
    'When you finish, summarize what you changed in a few sentences.',
  ];
  if (ws.kind === 'github') {
    lines.push(
      'Your edits are staged in the browser until committed. Only call commit_changes or open_pull_request when the user asks you to.',
      `When committing, use a new branch like "agent/<short-topic>" unless the user names one. Do not target "${ws.defaultBranch}" unless the user explicitly asks.`,
    );
  } else {
    lines.push('Edits are written straight to disk, so be deliberate.');
  }
  if (sandbox) {
    lines.push(
      'You also have a sandbox: a Linux container with Node.js 22, npm, git and python3, holding a copy of the workspace (it starts on first use).',
      'Your file edits are copied into the sandbox automatically before each sandbox tool runs. Files that commands create (node_modules, build output, lockfiles) exist only in the sandbox; use save_from_sandbox for any you want to keep.',
      'Use run_command for installs, builds, tests and scripts. Use start_server for web servers; they must listen on 0.0.0.0. The user sees the running app in a preview pane.',
      'Test backends with http_request and check server_logs when something fails. The sandbox has internet access for package installs but cannot reach private networks.',
    );
  }
  return lines.join('\n');
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  return JSON.parse(raw);
}

const clip = (s) => (s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + `\n… truncated ${s.length - MAX_RESULT_CHARS} characters` : s);

export class Agent {
  messages = [];

  // sandbox is optional: a Sandbox from sandbox-client.js when the runner is available.
  reset(ws, sandbox = null) {
    this.ws = ws;
    this.sandbox = sandbox;
    this.messages = ws ? [{ role: 'system', content: systemPrompt(ws, sandbox) }] : [];
  }

  // on: { text(str), toolStart(call) -> view, toolEnd(view, result, failed), usage(usage) }
  async run(text, { model, signal, on }) {
    this.messages.push({ role: 'user', content: text });
    const tools = toolDefs(this.ws, this.sandbox);
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await chat({ model, messages: this.messages, tools, signal });
      on.usage?.(res.usage);
      const msg = res.choices?.[0]?.message;
      if (!msg) throw new Error('The model returned no message.');
      const calls = msg.tool_calls ?? [];
      this.messages.push({
        role: 'assistant',
        content: msg.content ?? '',
        ...(calls.length && { tool_calls: calls }),
        ...(msg.reasoning_details && { reasoning_details: msg.reasoning_details }),
      });
      if (msg.content) on.text(msg.content);
      if (!calls.length) return;

      // Every tool_call id needs a tool message, even when the user stops mid-batch.
      for (const call of calls) {
        let result;
        if (signal.aborted) {
          result = 'Error: stopped by the user before this tool ran.';
        } else {
          const view = on.toolStart(call);
          let failed = false;
          try {
            result = String(await runTool(this.ws, call.function.name, parseArgs(call.function.arguments), this.sandbox));
          } catch (e) {
            failed = true;
            result = `Error: ${e.message}`;
          }
          on.toolEnd(view, result, failed);
        }
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: clip(result) });
      }
      if (signal.aborted) throw new DOMException('Stopped', 'AbortError');
    }
    on.text(`Stopped after ${MAX_STEPS} steps. Send "continue" to keep going.`);
  }
}
