import fs from 'node:fs';
import path from 'node:path';

/** Create a directory recursively. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Write a file through a sibling temp file and rename. */
export function atomicWriteFile(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** Read and parse a JSON file; a missing or invalid file yields `fallback`. */
export function readJsonIfExists(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** List directory entries, returning an empty array when the directory is absent. */
export function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
