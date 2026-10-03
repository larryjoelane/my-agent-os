// A GitHub repo as the agent's workspace. Reads come from one branch's tree;
// writes and deletes are staged in memory, then land as a single commit
// through the Git Data API (blobs -> tree -> commit -> ref).

const API = 'https://api.github.com';

export class GitHubWorkspace {
  kind = 'github';

  constructor({ token, repo, branch, allowDefaultBranch }) {
    const [owner, name] = repo.trim().split('/');
    if (!owner || !name) throw new Error('Repository must look like owner/repo.');
    this.token = token.trim();
    this.owner = owner;
    this.name = name;
    this.branch = branch?.trim() || '';
    this.allowDefaultBranch = !!allowDefaultBranch;
    this.files = new Map();   // path -> { sha, size, mode } at the branch head
    this.staged = new Map();  // path -> new content, or null for a delete
    this.blobs = new Map();   // sha -> bytes
  }

  get label() { return `${this.owner}/${this.name}@${this.branch}`; }

  async api(path, { method = 'GET', body } = {}) {
    const res = await fetch(`${API}/repos/${this.owner}/${this.name}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(`GitHub ${res.status}: ${data?.message || res.statusText}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  refPath(branch) {
    return `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;
  }

  async connect() {
    const repo = await this.api('');
    this.defaultBranch = repo.default_branch;
    this.branch ||= repo.default_branch;
    await this.refresh();
  }

  async refresh() {
    const ref = await this.api(this.refPath(this.branch));
    this.headSha = ref.object.sha;
    const commit = await this.api(`/git/commits/${this.headSha}`);
    const tree = await this.api(`/git/trees/${commit.tree.sha}?recursive=1`);
    this.truncated = tree.truncated;
    this.files = new Map(
      tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, { sha: e.sha, size: e.size, mode: e.mode }]),
    );
  }

  paths() {
    const all = new Set(this.files.keys());
    for (const [path, content] of this.staged) {
      if (content === null) all.delete(path);
      else all.add(path);
    }
    return [...all].sort();
  }

  exists(path) {
    if (this.staged.has(path)) return this.staged.get(path) !== null;
    return this.files.has(path);
  }

  size(path) {
    if (this.staged.has(path)) return this.staged.get(path)?.length ?? 0;
    return this.files.get(path)?.size ?? 0;
  }

  async readBytes(path) {
    if (this.staged.has(path)) {
      const content = this.staged.get(path);
      if (content === null) throw new Error(`${path} was deleted.`);
      return new TextEncoder().encode(content);
    }
    const entry = this.files.get(path);
    if (!entry) throw new Error(`${path} does not exist.`);
    if (!this.blobs.has(entry.sha)) {
      const blob = await this.api(`/git/blobs/${entry.sha}`);
      this.blobs.set(entry.sha, Uint8Array.from(atob(blob.content.replace(/\n/g, '')), (c) => c.charCodeAt(0)));
    }
    return this.blobs.get(entry.sha);
  }

  async read(path) {
    if (this.staged.has(path) && this.staged.get(path) !== null) return this.staged.get(path);
    const bytes = await this.readBytes(path);
    if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${path} is a binary file.`);
    return new TextDecoder().decode(bytes);
  }

  // onChange(paths) lets the sandbox mirror edits; set by whoever needs it.
  async write(path, content) {
    this.staged.set(path, content);
    this.onChange?.([path]);
  }

  async remove(path) {
    if (!this.exists(path)) throw new Error(`${path} does not exist.`);
    if (this.files.has(path)) this.staged.set(path, null);
    else this.staged.delete(path);
    this.onChange?.([path]);
  }

  changes() {
    return [...this.staged].map(([path, content]) => ({
      path,
      status: content === null ? 'deleted' : this.files.has(path) ? 'modified' : 'added',
    }));
  }

  discard() {
    const paths = [...this.staged.keys()];
    this.staged.clear();
    this.onChange?.(paths);
  }

  // Commits every staged change to `branch`, creating it from the current
  // head if it does not exist yet. Afterwards the workspace follows `branch`.
  async commit(message, branch = this.branch) {
    if (!this.staged.size) throw new Error('There are no staged changes to commit.');
    if (branch === this.defaultBranch && !this.allowDefaultBranch) {
      throw new Error(`Committing to the default branch "${branch}" is disabled. Use a new branch, or enable it in the sidebar.`);
    }
    let parent = this.headSha;
    let exists = true;
    try {
      parent = (await this.api(this.refPath(branch))).object.sha;
    } catch (e) {
      if (e.status !== 404) throw e;
      exists = false;
    }
    const baseTree = (await this.api(`/git/commits/${parent}`)).tree.sha;
    const tree = await this.api('/git/trees', {
      method: 'POST',
      body: {
        base_tree: baseTree,
        tree: [...this.staged].map(([path, content]) =>
          content === null
            ? { path, mode: this.files.get(path)?.mode ?? '100644', type: 'blob', sha: null }
            : { path, mode: this.files.get(path)?.mode ?? '100644', type: 'blob', content }),
      },
    });
    const commit = await this.api('/git/commits', {
      method: 'POST',
      body: { message, tree: tree.sha, parents: [parent] },
    });
    if (exists) {
      await this.api(this.refPath(branch).replace('/git/ref/', '/git/refs/'), { method: 'PATCH', body: { sha: commit.sha } });
    } else {
      await this.api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
    }
    this.staged.clear();
    this.branch = branch;
    await this.refresh();
    return { sha: commit.sha, url: commit.html_url, branch };
  }

  async openPullRequest({ title, body = '', head = this.branch, base = this.defaultBranch }) {
    const pr = await this.api('/pulls', { method: 'POST', body: { title, body, head, base } });
    return { number: pr.number, url: pr.html_url };
  }
}
