import fs from 'node:fs';
import path from 'node:path';

/** Read a JSONL file into an array. A missing file yields an empty array. */
export function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    rows.push(JSON.parse(trimmed));
  }
  return rows;
}

/** Write rows as JSONL, creating parent directories when needed. */
export function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(file, body === '' ? '' : `${body}\n`);
}

/** Append one row to a JSONL file. */
export function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}
