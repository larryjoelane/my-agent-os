// Single responsibility: keep byte-for-byte copies of an agent's raw
// session log, gzipped, as files under the sessions dir. No parsing —
// the raw format belongs to whichever agent wrote it; this module only
// copies, compresses and restores bytes.
//
// Files live at <sessionsDir>/raw/<session-id>.<ext>.gz, and callers store
// the path relative to sessionsDir so the store can move as a whole.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// session id -> safe file stem. Ids are UUIDs in practice; this just
// keeps any other agent's id from escaping the raw dir.
function fileStem(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
}

// Copy sourcePath into the archive, gzipped. Overwrites an earlier copy
// of the same session, since a later save has the longer log.
// -> { rawPath (relative to sessionsDir), rawBytes (uncompressed), storedBytes }.
function archive(sessionsDir, sessionId, sourcePath) {
  const bytes = fs.readFileSync(sourcePath);
  const ext = path.extname(sourcePath) || '.log';
  const rawPath = path.posix.join('raw', `${fileStem(sessionId)}${ext}.gz`);
  const target = path.join(sessionsDir, rawPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(target, gz);
  return { rawPath, rawBytes: bytes.length, storedBytes: gz.length };
}

// bytes -> true when they start with the gzip magic number (1f 8b).
function isGzip(bytes) {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// (sessionsDir, rawPath) -> the original log's bytes. Decides by content,
// not by the .gz extension: gzipped archives are decompressed, anything
// else (e.g. a log copied in by hand) is returned as-is.
function restore(sessionsDir, rawPath) {
  const file = path.join(sessionsDir, rawPath);
  if (!fs.existsSync(file)) throw new Error(`raw archive missing: ${file}`);
  const bytes = fs.readFileSync(file);
  return isGzip(bytes) ? zlib.gunzipSync(bytes) : bytes;
}

// (sessionsDir, rawPath) -> the restored log written out as a plain file
// at <sessionsDir>/extracted/<name without .gz>, so it can be opened
// without going through show --raw. Skips the write when the extracted
// copy is already at least as new as the archive (a re-save with --raw
// replaces the archive, which makes the copy stale).
// -> { path (absolute), bytes, extracted (false when the copy was current) }.
function extract(sessionsDir, rawPath) {
  const source = path.join(sessionsDir, rawPath);
  if (!fs.existsSync(source)) throw new Error(`raw archive missing: ${source}`);
  const target = path.join(sessionsDir, 'extracted', path.basename(rawPath).replace(/\.gz$/, ''));
  if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= fs.statSync(source).mtimeMs) {
    return { path: target, bytes: fs.statSync(target).size, extracted: false };
  }
  const bytes = restore(sessionsDir, rawPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { path: target, bytes: bytes.length, extracted: true };
}

module.exports = { archive, restore, extract };
