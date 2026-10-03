// UI wiring. All model and tool output is rendered with textContent, never as
// HTML: this page holds API keys, so untrusted text must not become markup.

import * as openrouter from './openrouter.js';
import * as githubAuth from './github-auth.js';
import { GitHubWorkspace } from './github.js';
import { LocalWorkspace } from './local.js';
import { Agent } from './agent.js';
import { Sandbox } from './sandbox-client.js';

const $ = (id) => document.getElementById(id);
const agent = new Agent();
let ws = null;
let running = null; // AbortController while the agent works
const tokens = { prompt: 0, completion: 0, cost: 0 };

const prefs = {
  get(k) { try { return localStorage.getItem(`agentHarness.${k}`) ?? ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(`agentHarness.${k}`, v); } catch {} },
};

function setStatus(el, text, kind = '') {
  el.textContent = text;
  el.className = `status ${kind}`;
}

// --- chat log ---------------------------------------------------------------

function append(node) {
  const log = $('log');
  log.querySelector('.empty')?.remove();
  log.append(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

function addMessage(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  return append(div);
}

function addLink(prefix, url) {
  const div = addMessage('note', prefix);
  if (/^https:\/\/github\.com\//.test(url)) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = url;
    div.append(a);
  }
}

function toolStart(call) {
  const details = document.createElement('details');
  details.className = 'tool';
  const summary = document.createElement('summary');
  let args = call.function.arguments || '{}';
  try { args = JSON.stringify(JSON.parse(args), null, 2); } catch {}
  const brief = args.replace(/\s+/g, ' ').slice(0, 100);
  summary.textContent = `${call.function.name} ${brief} `;
  const state = document.createElement('span');
  state.className = 'pending';
  state.textContent = '…';
  summary.append(state);
  const argPre = document.createElement('pre');
  argPre.textContent = args;
  details.append(summary, argPre);
  append(details);
  return { details, state };
}

function toolEnd({ details, state }, result, failed) {
  state.className = failed ? 'failed' : '';
  state.textContent = failed ? '✗' : '✓';
  const pre = document.createElement('pre');
  pre.textContent = result;
  details.append(pre);
  renderChanges();
}

function showUsage(usage) {
  if (!usage) return;
  tokens.prompt += usage.prompt_tokens || 0;
  tokens.completion += usage.completion_tokens || 0;
  tokens.cost += usage.cost || 0;
  $('usage').textContent = `${tokens.prompt.toLocaleString()} in · ${tokens.completion.toLocaleString()} out`
    + (tokens.cost ? ` · $${tokens.cost.toFixed(4)}` : '');
}

// --- OpenRouter auth and models ---------------------------------------------

function renderAuth() {
  const signedIn = !!openrouter.getKey();
  $('login').hidden = signedIn;
  $('logout').hidden = !signedIn;
  $('auth-status').textContent = signedIn ? 'OpenRouter connected' : '';
}

let models = [];

// Fills the <select> with models matching the filter, grouped by provider.
// The current choice stays listed even when the filter would hide it.
function renderModels() {
  const select = $('model');
  const current = select.value || prefs.get('model');
  const terms = $('model-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = models.filter((m) => m.id === current
    || terms.every((t) => m.id.toLowerCase().includes(t) || m.name.toLowerCase().includes(t)));
  const groups = new Map();
  for (const m of shown) {
    const provider = m.id.split('/')[0];
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(m);
  }
  select.replaceChildren(...[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, list]) => {
    const group = document.createElement('optgroup');
    group.label = provider;
    group.append(...list.map((m) => new Option(m.name || m.id, m.id)));
    return group;
  }));
  select.value = current;
  if (!select.value && select.options.length) select.selectedIndex = 0;
}

// config.json is served by the runner from its settings (deploy/.env). Missing
// or unreadable means the defaults: free models only, token-only GitHub
// access, no sandbox.
async function loadConfig() {
  const defaults = { allowAllModels: false, githubClientId: '', githubOAuthProxy: '', githubAppSlug: '', githubScope: '', runner: false, previewOrigin: '' };
  try {
    const res = await fetch('config.json', { cache: 'no-store' });
    if (!res.ok) return defaults;
    const cfg = await res.json();
    return Object.fromEntries(Object.entries(defaults).map(([k, d]) =>
      [k, typeof cfg[k] === typeof d ? cfg[k] : d]));
  } catch {
    return defaults;
  }
}

const configReady = loadConfig();

async function loadModels() {
  try {
    const { allowAllModels } = await configReady;
    $('model-scope').hidden = allowAllModels;
    models = (await openrouter.listModels())
      .filter((m) => !m.id.endsWith(':batch') && (allowAllModels || openrouter.isFree(m)));
    if (!models.some((m) => m.id === prefs.get('model'))) prefs.set('model', '');
    if (!prefs.get('model')) {
      prefs.set('model', (models.find((m) => m.id.startsWith('anthropic/claude-sonnet')) ?? models[0])?.id ?? '');
    }
    renderModels();
  } catch (e) {
    $('model').replaceChildren(new Option('Models unavailable', ''));
    addMessage('error', e.message);
  }
}

$('model-filter').addEventListener('input', renderModels);
$('model').addEventListener('change', () => prefs.set('model', $('model').value));

// --- workspace ---------------------------------------------------------------

function useWorkspace(next) {
  ws = next;
  if (runnerEnabled) sandbox.attach(ws);
  agent.reset(ws, runnerEnabled ? sandbox : null);
  $('log').replaceChildren();
  const note = ws.truncated ? ' (file list truncated; very large repo)' : '';
  setStatus($('ws-status'), `Connected to ${ws.label}: ${ws.paths().length} files${note}.`, 'ok');
  addMessage('note', `Workspace: ${ws.label}`);
  if (ws.kind === 'github') $('commit-branch').value = ws.branch === ws.defaultBranch ? 'agent/changes' : ws.branch;
  renderChanges();
}

function renderChanges() {
  const section = $('changes-section');
  const changes = ws?.kind === 'github' ? ws.changes() : [];
  section.hidden = !changes.length;
  const tag = { added: 'A', modified: 'M', deleted: 'D' };
  $('changes').replaceChildren(...changes.map((c) => {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = `tag ${c.status}`;
    t.textContent = tag[c.status];
    li.append(t, c.path);
    return li;
  }));
}

// Shows "Sign in with GitHub" when the site is configured for it, and the
// repos the signed-in user can reach. The token form remains as a fallback.
async function renderGitHubAuth() {
  const cfg = await configReady;
  const oauth = githubAuth.isConfigured(cfg);
  const session = oauth ? githubAuth.getSession() : null;
  $('gh-oauth').hidden = !oauth;
  $('gh-login').hidden = !!session;
  $('gh-user').hidden = !session;
  $('gh-repo-pick').hidden = !session;
  $('gh-install').hidden = !(session && cfg.githubAppSlug);
  if (cfg.githubAppSlug) $('gh-install').href = `https://github.com/apps/${encodeURIComponent(cfg.githubAppSlug)}/installations/new`;
  $('gh-pat').hidden = !!session;
  if (!oauth) $('gh-pat').open = true;
  if (!session) return;

  $('gh-user-name').textContent = `Signed in as ${session.login}`;
  const select = $('gh-repo-select');
  select.replaceChildren(new Option('Loading repositories…', ''));
  try {
    const repos = await githubAuth.listRepos(session.token);
    select.replaceChildren(...repos.map((r) => new Option(r, r)));
    if (!repos.length) select.replaceChildren(new Option('No repositories yet. Add some below.', ''));
    if (repos.includes(prefs.get('ghRepo'))) select.value = prefs.get('ghRepo');
  } catch (err) {
    select.replaceChildren(new Option('Could not load repositories', ''));
    setStatus($('ws-status'), err.message, 'error');
    if (!githubAuth.getSession()) renderGitHubAuth();
  }
}

function bindWorkspaceForms() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab.dataset.tab;
    });
  }

  $('gh-token').value = prefs.get('ghToken');
  $('gh-repo').value = prefs.get('ghRepo');
  $('gh-branch').value = prefs.get('ghBranch');

  $('gh-login').addEventListener('click', async () => githubAuth.login(await configReady));
  $('gh-logout').addEventListener('click', () => { githubAuth.logout(); renderGitHubAuth(); });

  $('gh-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    const session = githubAuth.getSession();
    const usePat = !session;
    const token = usePat ? $('gh-token').value.trim() : session.token;
    const repo = usePat ? $('gh-repo').value.trim() : $('gh-repo-select').value;
    if (!token) return setStatus($('ws-status'), 'Sign in with GitHub or enter a token.', 'error');
    if (!repo) return setStatus($('ws-status'), 'Choose a repository.', 'error');
    btn.disabled = true;
    setStatus($('ws-status'), 'Connecting…');
    try {
      const next = new GitHubWorkspace({
        token,
        repo,
        branch: $('gh-branch').value,
        allowDefaultBranch: $('gh-allow-default').checked,
      });
      await next.connect();
      if (usePat) prefs.set('ghToken', token);
      prefs.set('ghRepo', repo);
      prefs.set('ghBranch', $('gh-branch').value.trim());
      useWorkspace(next);
    } catch (err) {
      if (err.status === 401 && !usePat) {
        githubAuth.logout();
        renderGitHubAuth();
        setStatus($('ws-status'), 'Your GitHub sign-in expired. Sign in again.', 'error');
      } else {
        setStatus($('ws-status'), err.message, 'error');
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('gh-allow-default').addEventListener('change', (e) => {
    if (ws?.kind === 'github') ws.allowDefaultBranch = e.target.checked;
  });

  $('pick-folder').addEventListener('click', async () => {
    try {
      setStatus($('ws-status'), 'Reading folder…');
      useWorkspace(await LocalWorkspace.pick());
    } catch (err) {
      if (err.name !== 'AbortError') setStatus($('ws-status'), err.message, 'error');
      else setStatus($('ws-status'), '');
    }
  });

  $('commit-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const { sha, url, branch } = await ws.commit($('commit-msg').value.trim(), $('commit-branch').value.trim());
      $('commit-msg').value = '';
      addLink(`Committed ${sha.slice(0, 7)} to ${branch}: `, url);
      setStatus($('ws-status'), `Connected to ${ws.label}.`, 'ok');
    } catch (err) {
      addMessage('error', err.message);
    } finally {
      btn.disabled = false;
      renderChanges();
    }
  });

  $('discard').addEventListener('click', () => {
    if (!confirm('Discard all staged changes?')) return;
    ws.discard();
    renderChanges();
    addMessage('note', 'Discarded staged changes.');
  });
}

// --- prompt -----------------------------------------------------------------

async function send() {
  const text = $('prompt').value.trim();
  if (!text || running) return;
  if (!openrouter.getKey()) return addMessage('error', 'Log in with OpenRouter first.');
  if (!ws) return addMessage('error', 'Connect a workspace first.');
  const model = $('model').value.trim();
  if (!model) return addMessage('error', 'Choose a model.');
  if (!(await configReady).allowAllModels && !models.some((m) => m.id === model && openrouter.isFree(m))) {
    return addMessage('error', `${model} is not a free model, and only free models are enabled.`);
  }
  prefs.set('model', model);

  $('prompt').value = '';
  addMessage('user', text);
  running = new AbortController();
  $('send').disabled = true;
  $('stop').hidden = false;
  try {
    await agent.run(text, {
      model,
      signal: running.signal,
      on: { text: (t) => addMessage('assistant', t), toolStart, toolEnd, usage: showUsage },
    });
  } catch (err) {
    addMessage(err.name === 'AbortError' ? 'note' : 'error', err.name === 'AbortError' ? 'Stopped.' : err.message);
    renderAuth();
  } finally {
    running = null;
    $('send').disabled = false;
    $('stop').hidden = true;
    renderChanges();
  }
}

function bindPrompt() {
  $('prompt-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('prompt').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  $('stop').addEventListener('click', () => running?.abort());
  $('new-chat').addEventListener('click', () => {
    if (running) return;
    agent.reset(ws, runnerEnabled ? sandbox : null);
    $('log').replaceChildren();
    if (ws) addMessage('note', `New chat. Workspace: ${ws.label}`);
  });
}

// --- sandbox and preview -------------------------------------------------------

// The runner (when this page is served by it) gives the agent a sandbox pod.
let runnerEnabled = false;

// The runner authenticates with the same GitHub token the workspace uses.
function sandboxToken() {
  if (ws?.kind === 'github') return ws.token;
  return githubAuth.getSession()?.token || prefs.get('ghToken');
}

const sandbox = new Sandbox({
  getToken: sandboxToken,
  onEvent(e) {
    const status = $('sbx-status');
    if (e.type === 'starting') setStatus(status, 'Starting… The first start downloads the sandbox image and can take a few minutes.');
    if (e.type === 'running') {
      setStatus(status, 'Running.', 'ok');
      if (e.skipped?.length) addMessage('note', `Not copied to the sandbox (over 10 MB): ${e.skipped.join(', ')}`);
    }
    if (e.type === 'stopped') {
      setStatus(status, 'Stopped.');
      $('preview').hidden = true;
    }
    if (e.type === 'server') {
      if (e.port) {
        setStatus(status, `Running. Server on port ${e.port}${e.listening ? '' : ' (not answering yet)'}.`, 'ok');
        showPreview();
      } else {
        setStatus(status, 'Running. No server.', 'ok');
      }
    }
    const live = !!sandbox.session;
    $('sbx-start').disabled = live;
    $('sbx-stop').disabled = !live;
    $('sbx-preview').disabled = !live;
  },
});

function showPreview(path = $('preview-path').value || '/') {
  const url = sandbox.previewUrl(path);
  if (!url) return;
  $('preview-path').value = path;
  $('preview-open').href = url;
  $('preview-frame').src = url;
  $('preview').hidden = false;
}

async function refreshLogs() {
  try {
    $('preview-logs').textContent = (await sandbox.logs(20000)) || '(no output)';
  } catch (e) {
    $('preview-logs').textContent = e.message;
  }
}

function bindSandbox() {
  $('sbx-start').addEventListener('click', async () => {
    if (!ws) return setStatus($('sbx-status'), 'Connect a workspace first.', 'error');
    try { await sandbox.ensure(); } catch (e) { setStatus($('sbx-status'), e.message, 'error'); }
  });
  $('sbx-stop').addEventListener('click', () => sandbox.stop());
  $('sbx-preview').addEventListener('click', () => showPreview());
  $('preview-bar').addEventListener('submit', (e) => { e.preventDefault(); showPreview(); });
  $('preview-close').addEventListener('click', () => { $('preview').hidden = true; });
  $('preview-logs-box').addEventListener('toggle', (e) => { if (e.target.open) refreshLogs(); });
  configReady.then((cfg) => {
    runnerEnabled = cfg.runner;
    $('sandbox-section').hidden = !runnerEnabled;
  });
}

// --- start ------------------------------------------------------------------

$('login').addEventListener('click', () => openrouter.login());
$('logout').addEventListener('click', () => { openrouter.logout(); renderAuth(); });
bindWorkspaceForms();
bindPrompt();
bindSandbox();

// Both logins redirect back here with ?code=; GitHub's also echoes our state.
try {
  if (githubAuth.isCallback()) {
    await githubAuth.completeLogin(await configReady);
    addMessage('note', 'Signed in with GitHub.');
  } else if (await openrouter.completeLogin()) {
    addMessage('note', 'Logged in with OpenRouter.');
  }
} catch (e) {
  addMessage('error', e.message);
}
renderAuth();
renderGitHubAuth();
loadModels();
