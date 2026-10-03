// Client for the runner's sandbox API (same origin as this page). A sandbox is
// a Linux pod holding a copy of the workspace: GitHub workspaces are cloned at
// the connected commit and then get the staged edits; local folders are
// uploaded. Every later edit is queued and pushed before the next sandbox call,
// so commands always see what the agent just wrote.

const MAX_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Sandbox {
  // getToken() -> GitHub token for the runner; onEvent({ type, ... }) for the UI.
  constructor({ getToken, onEvent }) {
    this.getToken = getToken;
    this.onEvent = onEvent;
    this.session = null;   // { id, previewUrl }
    this.pending = new Set();
    this.starting = null;
    this.flushing = Promise.resolve();
  }

  attach(ws) {
    this.stop();
    this.ws = ws;
    this.pending.clear();
    ws.onChange = (paths) => { if (this.session) for (const p of paths) this.pending.add(p); };
  }

  async api(method, path, body) {
    const token = this.getToken();
    if (!token) throw new Error('Sign in with GitHub (or add a token) to use the sandbox.');
    const res = await fetch(`/__runner/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`Sandbox: ${data.error || `HTTP ${res.status}`}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  ensure() {
    if (this.session) return Promise.resolve(this.session);
    this.starting ||= this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async start() {
    const ws = this.ws;
    if (!ws) throw new Error('Connect a workspace first.');
    this.onEvent?.({ type: 'starting' });
    try {
      const body = ws.kind === 'github' ? { repo: `${ws.owner}/${ws.name}`, ref: ws.headSha } : {};
      this.session = await this.api('POST', '/sessions', body);
      const initial = ws.kind === 'github' ? ws.changes().map((c) => c.path) : ws.paths();
      for (const p of initial) this.pending.add(p);
      const skipped = await this.flush();
      this.onEvent?.({ type: 'running', skipped });
      return this.session;
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  // Pushes queued edits. Returns paths skipped for being too large.
  flush() {
    const run = this.flushing.then(() => this.flushNow());
    this.flushing = run.catch(() => {});
    return run;
  }

  async flushNow() {
    if (!this.session || !this.pending.size) return [];
    const paths = [...this.pending];
    this.pending.clear();
    const skipped = [];
    let batch = { write: {}, delete: [] };
    let size = 0;
    let total = 0;
    const send = async () => {
      if (Object.keys(batch.write).length || batch.delete.length) await this.api('POST', `/sessions/${this.session.id}/files`, batch);
      batch = { write: {}, delete: [] };
      size = 0;
    };
    try {
      for (const p of paths) {
        if (!this.ws.exists(p)) { batch.delete.push(p); continue; }
        if (this.ws.size(p) > MAX_FILE_BYTES) { skipped.push(p); continue; }
        const bytes = await this.ws.readBytes(p);
        total += bytes.length;
        if (total > MAX_TOTAL_BYTES) throw new Error('The workspace is too large to upload to the sandbox (over 200 MB).');
        batch.write[p] = base64(bytes);
        size += bytes.length;
        if (size >= MAX_BATCH_BYTES) await send();
      }
      await send();
    } catch (e) {
      for (const p of paths) this.pending.add(p); // retried on the next call
      throw e;
    }
    return skipped;
  }

  // A session call; if the runner reaped the sandbox, start a fresh one once.
  async call(method, suffix, body, retried = false) {
    const s = await this.ensure();
    await this.flush();
    try {
      return await this.api(method, `/sessions/${s.id}${suffix}`, body);
    } catch (e) {
      if (e.status !== 404 || retried || !/No such session/.test(e.message)) throw e;
      this.session = null;
      this.onEvent?.({ type: 'stopped' });
      return this.call(method, suffix, body, true);
    }
  }

  exec(command, timeout) { return this.call('POST', '/exec', { command, timeout }); }

  async startServer(command, port) {
    const r = await this.call('POST', '/server', { command, port });
    this.onEvent?.({ type: 'server', port: r.port, listening: r.listening });
    return r;
  }

  async stopServer() {
    if (!this.session) return;
    await this.call('DELETE', '/server');
    this.onEvent?.({ type: 'server', port: null });
  }

  async logs(bytes) { return (await this.call('GET', `/server/logs?bytes=${bytes || 20000}`)).logs; }
  http(request) { return this.call('POST', '/http', request); }

  async readFile(path) {
    const { content } = await this.call('GET', `/file?path=${encodeURIComponent(path)}`);
    return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  }

  previewUrl(path = '/') {
    return this.session && `${this.session.previewUrl}&path=${encodeURIComponent(path.startsWith('/') ? path : `/${path}`)}`;
  }

  async stop() {
    const s = this.session;
    this.session = null;
    this.pending.clear();
    if (s) {
      this.onEvent?.({ type: 'stopped' });
      await this.api('DELETE', `/sessions/${s.id}`).catch(() => {});
    }
  }
}
