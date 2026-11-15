/**
 * DSH session-log decoding.
 *
 * A `session.v4.jsonl.zstd` file starts with one header frame followed by one
 * independent zstd frame per durable append batch. `zlib.zstdDecompressSync`
 * decodes a single frame, so the file must be split on the zstd magic first.
 * The split is byte-based; a magic sequence can theoretically appear inside a
 * compressed frame, so decoding retries by extending the candidate span when a
 * segment does not decompress.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Typed decode failure that names the stage. */
export class SessionLogError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SessionLogError';
    this.code = code;
  }
}

function magicOffsets(buffer) {
  const offsets = [];
  let index = 0;
  while (index <= buffer.length - ZSTD_MAGIC.length) {
    const found = buffer.indexOf(ZSTD_MAGIC, index);
    if (found === -1) break;
    offsets.push(found);
    index = found + 1;
  }
  return offsets;
}

/** Split a buffer at every zstd magic; throws when no frame is present. */
export function splitZstdFrames(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('splitZstdFrames requires a Buffer');
  const offsets = magicOffsets(buffer);
  if (offsets.length === 0) throw new SessionLogError('no zstd frame found', 'no-frames');
  return offsets.map((start, index) => buffer.subarray(start, index + 1 < offsets.length ? offsets[index + 1] : buffer.length));
}

function tryDecompress(segment) {
  try {
    return zlib.zstdDecompressSync(segment);
  } catch {
    return null;
  }
}

/**
 * Decode a full session log.
 *
 * @returns {{header: object, events: object[], frameCount: number, warnings: string[]}}
 */
export function decodeSessionLog(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('decodeSessionLog requires a Buffer');
  const offsets = magicOffsets(buffer);
  if (offsets.length === 0) throw new SessionLogError('no zstd frame found', 'no-frames');
  const warnings = [];
  const chunks = [];
  let index = 0;
  while (index < offsets.length) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    let decoded = tryDecompress(buffer.subarray(start, end));
    if (decoded === null) {
      let merged = null;
      let consumed = index;
      for (let next = index + 1; next < offsets.length; next += 1) {
        const mergedEnd = next + 1 < offsets.length ? offsets[next + 1] : buffer.length;
        merged = tryDecompress(buffer.subarray(start, mergedEnd));
        if (merged !== null) {
          consumed = next;
          break;
        }
      }
      if (merged === null) {
        warnings.push(`skipped undecodable frame at byte ${start}`);
        index += 1;
        continue;
      }
      decoded = merged;
      index = consumed;
    }
    chunks.push(decoded);
    index += 1;
  }
  if (chunks.length === 0) throw new SessionLogError('no decodable zstd frame', 'bad-frame');

  const headerLines = chunks[0].toString('utf8').split('\n').filter((line) => line.trim() !== '');
  if (headerLines.length === 0) throw new SessionLogError('empty session header frame', 'bad-header');
  let header;
  try {
    header = JSON.parse(headerLines[0]);
  } catch (error) {
    throw new SessionLogError(`invalid session header: ${error.message}`, 'bad-header');
  }

  const events = [];
  for (let chunkIndex = 1; chunkIndex < chunks.length; chunkIndex += 1) {
    const lines = chunks[chunkIndex].toString('utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        warnings.push(`skipped non-JSON event line in frame ${chunkIndex}`);
      }
    }
  }
  return { header, events, frameCount: chunks.length, warnings };
}

/** Read and decode a session log file. */
export function readSessionLog(file) {
  return decodeSessionLog(fs.readFileSync(file));
}
