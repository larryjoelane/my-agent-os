// A local folder as the agent's workspace, through the File System Access API
// (Chromium only). Writes go straight to disk.

const SKIP = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next', '.cache']);
const MAX_FILES = 20000;

export class LocalWorkspace {
  kind = 'local';

  constructor(root) {
    this.root = root;
    this.files = new Map(); // path -> size
  }

  get label() { return `local folder "${this.root.name}"`; }

  static async pick() {
    if (!window.showDirectoryPicker) throw new Error('This browser cannot open local folders. Use Chrome or Edge.');
    const ws = new LocalWorkspace(await window.showDirectoryPicker({ mode: 'readwrite' }));
    await ws.refresh();
    return ws;
  }

  async refresh() {
    this.files.clear();
    const walk = async (dir, prefix) => {
      for await (const [name, handle] of dir.entries()) {
        if (this.files.size >= MAX_FILES) return;
        const path = prefix + name;
        if (handle.kind === 'directory') {
          if (!SKIP.has(name)) await walk(handle, path + '/');
        } else {
          this.files.set(path, (await handle.getFile()).size);
        }
      }
    };
    await walk(this.root, '');
    this.truncated = this.files.size >= MAX_FILES;
  }

  paths() { return [...this.files.keys()].sort(); }
  exists(path) { return this.files.has(path); }
  size(path) { return this.files.get(path) ?? 0; }

  async handle(path, create = false) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p === '.')) throw new Error(`Invalid path: ${path}`);
    let dir = this.root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name: parts.at(-1) };
  }

  async readBytes(path) {
    const { dir, name } = await this.handle(path);
    return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
  }

  async read(path) {
    const bytes = await this.readBytes(path);
    if (bytes.subarray(0, 8000).includes(0)) throw new Error(`${path} is a binary file.`);
    return new TextDecoder().decode(bytes);
  }

  // onChange(paths) lets the sandbox mirror edits; set by whoever needs it.
  async write(path, content) {
    const { dir, name } = await this.handle(path, true);
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(content);
    await writable.close();
    this.files.set(path, content.length);
    this.onChange?.([path]);
  }

  async remove(path) {
    const { dir, name } = await this.handle(path);
    await dir.removeEntry(name);
    this.files.delete(path);
    this.onChange?.([path]);
  }
}
