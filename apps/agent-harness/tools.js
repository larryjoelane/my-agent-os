// Tool definitions (OpenAI function format, as OpenRouter expects) and their
// implementations over a workspace (GitHubWorkspace or LocalWorkspace) and,
// when the runner is available, a sandbox for running code (sandbox-client.js).

const MAX_LIST = 1000;
const MAX_READ_LINES = 2000;
const MAX_SEARCH_FILES = 400;
const MAX_SEARCH_BYTES = 300_000;
const MAX_MATCHES = 200;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|eot|mp[34]|mov|wasm|exe|dll|so|dylib|jar|class|lock)$/i;

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const str = (description) => ({ type: 'string', description });

const COMMON = [
  fn('list_files', 'List file paths in the workspace, optionally under a directory prefix.',
    { path: str('Directory prefix, e.g. "src/". Omit for the whole workspace.') }),
  fn('read_file', 'Read a text file. Output lines are prefixed with line numbers and a tab; those prefixes are not part of the file.',
    { path: str('File path'), start_line: { type: 'integer', description: '1-based first line' }, end_line: { type: 'integer', description: '1-based last line, inclusive' } },
    ['path']),
  fn('search_files', 'Search file contents with a JavaScript regular expression. Returns path:line: text for each match.',
    { pattern: str('Regular expression'), path: str('Directory prefix to limit the search'), case_insensitive: { type: 'boolean' } },
    ['pattern']),
  fn('write_file', 'Create a file or replace its entire contents.',
    { path: str('File path'), content: str('Full file contents') }, ['path', 'content']),
  fn('edit_file', 'Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Read the file first.',
    { path: str('File path'), old_string: str('Exact text to replace, without line-number prefixes'), new_string: str('Replacement text'), replace_all: { type: 'boolean' } },
    ['path', 'old_string', 'new_string']),
  fn('delete_file', 'Delete a file.', { path: str('File path') }, ['path']),
];

const GITHUB = [
  fn('list_changes', 'List staged changes that have not been committed yet.'),
  fn('commit_changes', 'Commit all staged changes as one commit. Creates the branch from the current head if it does not exist.',
    { message: str('Commit message'), branch: str('Target branch, e.g. "agent/fix-login"') }, ['message', 'branch']),
  fn('open_pull_request', 'Open a pull request from a branch that has commits.',
    { title: str('PR title'), body: str('PR description'), head: str('Branch with the changes (defaults to the current branch)'), base: str('Branch to merge into (defaults to the repo default branch)') },
    ['title']),
];

const SANDBOX = [
  fn('run_command', 'Run a shell command in the sandbox (bash, in the workspace root) and wait for it to finish. Use for installs, builds, tests and scripts; use start_server for anything long-running.',
    { command: str('Shell command, e.g. "npm install" or "npm test"'), timeout_seconds: { type: 'integer', description: 'Default 120, max 600' } },
    ['command']),
  fn('start_server', 'Start a long-running process (a web server or dev server) in the background, replacing any previous one, and show it in the user\'s preview pane. It must listen on 0.0.0.0 at the given port.',
    { command: str('e.g. "node server.js" or "npm run dev -- --host 0.0.0.0 --port 5173"'), port: { type: 'integer', description: 'Port the server listens on (1024-65535)' } },
    ['command', 'port']),
  fn('stop_server', 'Stop the background server.'),
  fn('server_logs', 'Show the most recent output of the background server.',
    { bytes: { type: 'integer', description: 'How much of the end of the log to return (default 20000)' } }),
  fn('http_request', 'Send an HTTP request to the background server and return the status, headers and body.',
    { method: str('GET, POST, PUT, PATCH or DELETE (default GET)'), path: str('Path and query, e.g. "/api/todos?done=1"'),
      headers: { type: 'object', description: 'Request headers', additionalProperties: { type: 'string' } }, body: str('Request body, e.g. JSON text') },
    ['path']),
  fn('save_from_sandbox', 'Copy a text file the sandbox produced (e.g. package-lock.json) into the workspace, so it is kept or committed. Max 1 MB.',
    { path: str('File path relative to the workspace root') }, ['path']),
];

export const toolDefs = (ws, sandbox) => [...COMMON, ...(ws.kind === 'github' ? GITHUB : []), ...(sandbox ? SANDBOX : [])];

const norm = (path = '') => path.replace(/\\/g, '/').replace(/^\.?\/+/, '');

function under(ws, prefix) {
  const p = norm(prefix);
  const dir = p && !p.endsWith('/') ? p + '/' : p;
  return ws.paths().filter((path) => !dir || path.startsWith(dir) || path === p);
}

const HANDLERS = {
  list_files(ws, { path }) {
    const paths = under(ws, path);
    if (!paths.length) return 'No files found.';
    const more = paths.length > MAX_LIST ? `\n… ${paths.length - MAX_LIST} more. Narrow with a path prefix.` : '';
    return paths.slice(0, MAX_LIST).join('\n') + more;
  },

  async read_file(ws, { path, start_line = 1, end_line }) {
    const lines = (await ws.read(norm(path))).split('\n');
    const start = Math.max(1, start_line);
    const end = Math.min(lines.length, end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join('\n');
    const rest = end < lines.length ? `\n… ${lines.length - end} more lines. Use start_line to continue.` : '';
    return (body || '(empty file)') + rest;
  },

  async search_files(ws, { pattern, path, case_insensitive }) {
    const re = new RegExp(pattern, case_insensitive ? 'i' : '');
    const candidates = under(ws, path).filter((p) => !BINARY_EXT.test(p) && ws.size(p) <= MAX_SEARCH_BYTES);
    const files = candidates.slice(0, MAX_SEARCH_FILES);
    const matches = [];
    let next = 0;
    const worker = async () => {
      while (next < files.length && matches.length < MAX_MATCHES) {
        const file = files[next++];
        let text;
        try { text = await ws.read(file); } catch { continue; }
        text.split('\n').forEach((line, i) => {
          if (matches.length < MAX_MATCHES && re.test(line)) matches.push(`${file}:${i + 1}: ${line.slice(0, 300)}`);
        });
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    const notes = [];
    if (candidates.length > files.length) notes.push(`Searched only the first ${files.length} of ${candidates.length} files; narrow with path.`);
    if (matches.length >= MAX_MATCHES) notes.push(`Stopped at ${MAX_MATCHES} matches.`);
    return [matches.join('\n') || 'No matches.', ...notes].join('\n');
  },

  async write_file(ws, { path, content }) {
    const p = norm(path);
    const existed = ws.exists(p);
    await ws.write(p, content);
    return `${existed ? 'Updated' : 'Created'} ${p} (${content.split('\n').length} lines).`;
  },

  async edit_file(ws, { path, old_string, new_string, replace_all }) {
    const p = norm(path);
    const text = await ws.read(p);
    if (!old_string) throw new Error('old_string is empty.');
    const count = text.split(old_string).length - 1;
    if (count === 0) throw new Error('old_string was not found. Re-read the file and copy the text exactly.');
    if (count > 1 && !replace_all) throw new Error(`old_string matches ${count} times. Add surrounding context or set replace_all.`);
    const updated = replace_all ? text.split(old_string).join(new_string) : text.replace(old_string, () => new_string);
    await ws.write(p, updated);
    return `Edited ${p} (${replace_all ? count : 1} replacement${count > 1 && replace_all ? 's' : ''}).`;
  },

  async delete_file(ws, { path }) {
    await ws.remove(norm(path));
    return `Deleted ${norm(path)}.`;
  },

  list_changes(ws) {
    const changes = ws.changes();
    return changes.length ? changes.map((c) => `${c.status}: ${c.path}`).join('\n') : 'No staged changes.';
  },

  async commit_changes(ws, { message, branch }) {
    const { sha, url, branch: b } = await ws.commit(message, branch);
    return `Committed ${sha.slice(0, 7)} to ${b}: ${url}`;
  },

  async open_pull_request(ws, args) {
    const { number, url } = await ws.openPullRequest(args);
    return `Opened PR #${number}: ${url}`;
  },

  async run_command(ws, { command, timeout_seconds }, sandbox) {
    const r = await sandbox.exec(command, timeout_seconds);
    const parts = [`exit code ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}`];
    if (r.stdout) parts.push(`--- stdout\n${r.stdout}`);
    if (r.stderr) parts.push(`--- stderr\n${r.stderr}`);
    if (r.truncated) parts.push('(output truncated)');
    return parts.join('\n');
  },

  async start_server(ws, { command, port }, sandbox) {
    const r = await sandbox.startServer(command, port);
    const state = r.listening
      ? `Server is listening on port ${r.port} and is shown in the preview pane.`
      : `Nothing is listening on port ${r.port} after 20s. Check that it binds 0.0.0.0:${r.port}, or read server_logs.`;
    return `${state}\n--- recent output\n${r.logs || '(none)'}`;
  },

  async stop_server(ws, args, sandbox) {
    await sandbox.stopServer();
    return 'Server stopped.';
  },

  async server_logs(ws, { bytes }, sandbox) {
    return (await sandbox.logs(bytes)) || '(no output)';
  },

  async http_request(ws, { method = 'GET', path, headers, body }, sandbox) {
    const r = await sandbox.http({ method, path, headers, body });
    const head = Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n');
    return `HTTP ${r.status}\n${head}\n\n${r.body}`;
  },

  async save_from_sandbox(ws, { path }, sandbox) {
    const p = norm(path);
    const bytes = await sandbox.readFile(p);
    if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${p} is a binary file; only text files can be saved.`);
    await ws.write(p, new TextDecoder().decode(bytes));
    sandbox.pending.delete(p); // the sandbox already has this content
    return `Saved ${p} from the sandbox into the workspace (${bytes.length} bytes).`;
  },
};

export async function runTool(ws, name, args, sandbox) {
  const handler = HANDLERS[name];
  if (!handler || !toolDefs(ws, sandbox).some((t) => t.function.name === name)) throw new Error(`Unknown tool: ${name}`);
  return handler(ws, args, sandbox);
}
