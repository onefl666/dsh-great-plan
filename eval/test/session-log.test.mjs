import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { SessionLogError, decodeSessionLog, readSessionLog, splitZstdFrames } from '../interactive-swe/session/zstd-log.mjs';
import {
  advertisedToolNames,
  extractSession,
  findToolCalls,
  messageText,
  parseToolArguments,
  systemPromptText,
  usageTotals,
} from '../interactive-swe/session/events.mjs';
import { cwdSlug, findSessionLog, sessionLogRelativePath } from '../interactive-swe/session/locate.mjs';

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function logFrame(header, events) {
  return Buffer.concat([frame(`${JSON.stringify(header)}\n`), ...events.map((event) => frame(`${JSON.stringify(event)}\n`))]);
}

test('decodeSessionLog reads a header and one event per frame', () => {
  const buffer = logFrame({ type: 'session', version: 4, id: 's1' }, [
    { type: 'plan/mode', seq: 1, data: { active: true } },
    { type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 3 } } },
  ]);
  const decoded = decodeSessionLog(buffer);
  assert.equal(decoded.header.id, 's1');
  assert.equal(decoded.events.length, 2);
  assert.equal(decoded.frameCount, 3);
  assert.deepEqual(decoded.warnings, []);
});

test('splitZstdFrames returns every magic-aligned segment', () => {
  const buffer = Buffer.concat([frame('a'), frame('b'), frame('c')]);
  const segments = splitZstdFrames(buffer);
  assert.equal(segments.length, 3);
  assert.ok(segments.every((segment) => segment.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))));
});

test('empty and header-less logs fail with a typed error', () => {
  assert.throws(() => decodeSessionLog(Buffer.from('hello')), (error) => error instanceof SessionLogError && error.code === 'no-frames');
  assert.throws(() => decodeSessionLog(frame('not json')), (error) => error instanceof SessionLogError && error.code === 'bad-header');
});

test('an undecodable trailing frame is a warning, not data loss', () => {
  const valid = logFrame({ type: 'session' }, [{ type: 'plan/mode', seq: 1, data: { active: true } }]);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const buffer = Buffer.concat([valid, magic, Buffer.from([0, 0, 0, 0])]);
  const decoded = decodeSessionLog(buffer);
  assert.equal(decoded.events.length, 1);
  assert.ok(decoded.warnings.length >= 1);
});

test('readSessionLog reads a file', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, logFrame({ type: 'session' }, []));
  assert.equal(readSessionLog(file).header.type, 'session');
});

test('findSessionLog scans the sessions tree and rejects traversal ids', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'sessions', '--workspace--', 'session-abc');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(file, logFrame({ type: 'session' }, []));
  assert.equal(findSessionLog(home, 'session-abc'), file);
  assert.equal(findSessionLog(home, 'missing'), null);
  assert.equal(findSessionLog(home, '../session-abc'), null);
  assert.equal(findSessionLog(path.join(home, 'nope'), 'session-abc'), null);
});

test('cwd slug and relative path are deterministic', () => {
  assert.equal(cwdSlug('/Users/flyblue/x'), '--Users-flyblue-x--');
  assert.equal(sessionLogRelativePath('/a/b', 'sid'), path.join('sessions', '--a-b--', 'sid', 'session.v4.jsonl.zstd'));
});

test('extractSession pulls plan calls, questions, usage, and headers', () => {
  const events = [
    { type: 'system/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'system' }] } } },
    { type: 'plan/mode', seq: 2, data: { active: true } },
    {
      type: 'tool/call',
      seq: 3,
      data: { turn: 1, step: 1, callId: 'c1', name: 'exit_plan_mode', arguments: JSON.stringify({ plan: '# Plan\n- a.js:1' }) },
    },
    {
      type: 'tool/call',
      seq: 4,
      data: { turn: 1, step: 1, callId: 'c2', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1' }] }) },
    },
    { type: 'tool/result', seq: 5, data: { turn: 1, step: 1, error: { name: 'ASK_CANCELLED', code: 'ASK_CANCELLED' } } },
    {
      type: 'assistant/message',
      seq: 6,
      data: { message: { content: [{ type: 'text', text: 'hello' }] }, usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 } },
    },
    { type: 'request/header', seq: 7, data: { tools: [{ name: 'read' }, 'grep', { function: { name: 'spawn_teammate' } }] } },
    { type: 'command/run', seq: 8, data: { commandId: 'cmd1', name: 'plan', args: 'x' } },
    { type: 'team/task', seq: 9, data: { task: { id: 't1' } } },
    { type: 'user/message', seq: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'issue' }] } },
  ];
  const facts = extractSession(events);
  assert.equal(facts.planModeActive, true);
  assert.equal(findToolCalls(facts, 'exit_plan_mode').length, 1);
  assert.equal(findToolCalls(facts, 'ask_user_question')[0].args.questions[0].id, 'q1');
  assert.equal(facts.toolResults[0].isError, true);
  assert.equal(facts.toolResults[0].errorCode, 'ASK_CANCELLED');
  assert.deepEqual(usageTotals(facts), { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0 });
  assert.equal(systemPromptText(facts), 'system');
  assert.deepEqual(advertisedToolNames(facts), ['read', 'grep', 'spawn_teammate']);
  assert.equal(facts.commands[0].commandId, 'cmd1');
  assert.equal(facts.teamTasks.length, 1);
  assert.equal(facts.userMessages[0].sourceKind, 'user');
});

test('advertisedToolNames unwraps the real request/header shape', () => {
  const facts = extractSession([
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek-official' }, tools: [{ name: 'read' }, { name: 'spawn_teammate' }] } } },
  ]);
  assert.deepEqual(advertisedToolNames(facts), ['read', 'spawn_teammate']);
});

test('parseToolArguments and messageText tolerate shapes', () => {
  assert.deepEqual(parseToolArguments({ arguments: '{"a":1}' }), { a: 1 });
  assert.deepEqual(parseToolArguments({ args: { b: 2 } }), { b: 2 });
  assert.equal(parseToolArguments({ arguments: 'not json' }), null);
  assert.equal(messageText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'ab');
  assert.equal(messageText('plain'), 'plain');
  assert.equal(messageText(null), '');
});
