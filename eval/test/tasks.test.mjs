import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  REQUIRED_TASK_FIELDS,
  hashTasks,
  normalizeTaskRow,
  normalizeTasks,
  parseIdList,
  parseListString,
  selectIssue,
  selectTasks,
  validateTaskSet,
} from '../interactive-swe/tasks/schema.mjs';

function row(overrides = {}) {
  return {
    instance_id: 'octo__demo-1',
    repo: 'octo/demo',
    base_commit: '1'.repeat(40),
    version: '1.0',
    environment_setup_commit: '2'.repeat(40),
    problem_statement: 'Fix the bug.',
    original_issue: 'The bug happens when the list is empty; return [].',
    patch: '',
    test_patch: '',
    FAIL_TO_PASS: '["tests/test_a.py::test_a"]',
    PASS_TO_PASS: '["tests/test_b.py::test_b"]',
    files: '["a.py"]',
    difficulty: 'easy',
    hints_text: '',
    created_at: '2025-01-01',
    ...overrides,
  };
}

test('required field list is the fifteen dataset columns', () => {
  assert.equal(REQUIRED_TASK_FIELDS.length, 15);
  assert.ok(REQUIRED_TASK_FIELDS.includes('original_issue'));
  assert.ok(REQUIRED_TASK_FIELDS.includes('FAIL_TO_PASS'));
});

test('normalizeTaskRow parses list fields and preserves raw strings', () => {
  const task = normalizeTaskRow(row(), 0);
  assert.deepEqual(task.failToPass, ['tests/test_a.py::test_a']);
  assert.deepEqual(task.passToPass, ['tests/test_b.py::test_b']);
  assert.deepEqual(task.filesList, ['a.py']);
  assert.equal(task.failToPassRaw, '["tests/test_a.py::test_a"]');
});

test('normalizeTaskRow rejects missing fields and unsafe ids', () => {
  const missing = row();
  delete missing.repo;
  assert.throws(() => normalizeTaskRow(missing), /missing repo/);
  assert.throws(() => normalizeTaskRow(row({ instance_id: '../escape' })), /unsafe/);
});

test('normalizeTasks collects per-row errors', () => {
  const { tasks, errors } = normalizeTasks([row(), row({ instance_id: 'bad id' })]);
  assert.equal(tasks.length, 1);
  assert.equal(errors.length, 1);
});

test('parseListString accepts JSON and Python-literal lists', () => {
  assert.deepEqual(parseListString('["a", "b"]'), { ok: true, value: ['a', 'b'] });
  assert.deepEqual(parseListString("['a', 'b']"), { ok: true, value: ['a', 'b'] });
  assert.deepEqual(parseListString('not a list'), { ok: false, value: [] });
  assert.deepEqual(parseListString(''), { ok: false, value: [] });
});

test('selectIssue picks hidden or full text and rejects unknown modes', () => {
  const task = normalizeTaskRow(row());
  assert.equal(selectIssue(task, 'hidden'), 'Fix the bug.');
  assert.equal(selectIssue(task, 'full'), 'The bug happens when the list is empty; return [].');
  assert.throws(() => selectIssue(task, 'nope'), /unknown issue mode/);
});

test('parseIdList ignores comments and blank lines', () => {
  assert.deepEqual(parseIdList('# header\n\na__b-1\n c__d-2 \n'), ['a__b-1', 'c__d-2']);
});

test('selectTasks honors ids order, limit, offset, and missing ids', () => {
  const tasks = normalizeTasks([row(), row({ instance_id: 'octo__demo-2' }), row({ instance_id: 'octo__demo-3' })]).tasks;
  assert.deepEqual(selectTasks(tasks, { ids: ['octo__demo-3', 'octo__demo-1'] }).map((task) => task.instance_id), ['octo__demo-3', 'octo__demo-1']);
  assert.deepEqual(selectTasks(tasks, { limit: 2 }).map((task) => task.instance_id), ['octo__demo-1', 'octo__demo-2']);
  assert.deepEqual(selectTasks(tasks, { offset: 2 }).map((task) => task.instance_id), ['octo__demo-3']);
  assert.throws(() => selectTasks(tasks, { ids: ['missing'] }), /unknown task ids/);
});

test('selectTasks shuffling is deterministic per seed', () => {
  const tasks = normalizeTasks([row(), row({ instance_id: 'octo__demo-2' }), row({ instance_id: 'octo__demo-3' }), row({ instance_id: 'octo__demo-4' })]).tasks;
  const first = selectTasks(tasks, { seed: 42 }).map((task) => task.instance_id);
  const second = selectTasks(tasks, { seed: 42 }).map((task) => task.instance_id);
  assert.deepEqual(first, second);
  assert.deepEqual([...first].sort(), ['octo__demo-1', 'octo__demo-2', 'octo__demo-3', 'octo__demo-4']);
});

test('selectTasks stratified sample prefers repo spread', () => {
  const tasks = normalizeTasks([
    row({ instance_id: 'a__1', repo: 'a/a' }),
    row({ instance_id: 'a__2', repo: 'a/a' }),
    row({ instance_id: 'b__1', repo: 'b/b' }),
  ]).tasks;
  const sampled = selectTasks(tasks, { sample: 2 });
  assert.equal(sampled.length, 2);
  assert.deepEqual(sampled.map((task) => task.repo).sort(), ['a/a', 'b/b']);
});

test('hashTasks is independent of input order', () => {
  const first = normalizeTasks([row(), row({ instance_id: 'octo__demo-2' })]).tasks;
  const second = normalizeTasks([row({ instance_id: 'octo__demo-2' }), row()]).tasks;
  assert.equal(hashTasks(first), hashTasks(second));
});

test('validateTaskSet reports duplicates and blank required text', () => {
  const tasks = normalizeTasks([row(), row()]).tasks;
  const duplicate = validateTaskSet(tasks);
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors[0], /duplicate/);
  const blank = validateTaskSet(normalizeTasks([row({ problem_statement: '   ' })]).tasks);
  assert.equal(blank.ok, false);
});
