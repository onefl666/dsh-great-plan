/**
 * Out-of-process client for the DSH SDK stdio JSON-RPC server.
 *
 * The driver spawns the app CLI (one child per task), performs the
 * `initialize` handshake, sends one `session/query` with a `/plan <issue>`
 * text block, answers `user-question/ask` server requests through an injected
 * `questionPolicy`, rejects `approval/request`, and ends the session with the
 * `shutdown` RPC. Stdout is NDJSON JSON-RPC; stderr is diagnostic text.
 *
 * Every spawn/stream dependency is injectable so the offline tests can drive
 * the whole protocol with a fake child.
 */

import { spawn } from 'node:child_process';
import { nowIso } from '../util/time.mjs';
import { planContentBlocks } from './prompts.mjs';

/** Default wall-clock deadline for one task session. */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Default quiet period after a terminal signal before ending observation. */
export const DEFAULT_IDLE_SETTLE_MS = 8000;
/** Default grace period for the shutdown RPC and child exit. */
export const DEFAULT_SHUTDOWN_GRACE_MS = 5000;
/** How much stderr is kept in the result. */
export const STDERR_TAIL_CHARS = 4000;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether a question is the native plan review.
 *
 * @param {object} question a wire question
 * @returns {boolean} true for the `plan-review` intent/id
 */
export function isPlanReviewQuestion(question) {
  if (question === null || typeof question !== 'object') return false;
  if (question.id === 'plan-review') return true;
  return question.intent !== null && typeof question.intent === 'object' && question.intent.kind === 'plan-review';
}

/**
 * The label that approves a plan review (native default `Approve`).
 *
 * @param {object} question the plan-review question
 * @returns {string} the approve option label
 */
export function planReviewApproveLabel(question) {
  const approve = question?.intent?.approve;
  if (typeof approve === 'string' && approve !== '') return approve;
  if (approve !== null && typeof approve === 'object' && typeof approve.label === 'string' && approve.label !== '') {
    return approve.label;
  }
  return 'Approve';
}

/**
 * Classify the decision recorded for one answered question batch.
 *
 * @param {object[]} questions the asked questions
 * @param {{answers?: object[], cancelled?: boolean}} wire the reply sent back
 * @returns {'cancel'|'answer'|'approve'|'reject'} transcript decision
 */
export function classifyQuestionDecision(questions, wire) {
  if (wire !== null && typeof wire === 'object' && wire.cancelled === true) return 'cancel';
  const answers = Array.isArray(wire?.answers) ? wire.answers : [];
  const review = (Array.isArray(questions) ? questions : []).find((question) => isPlanReviewQuestion(question));
  if (review !== undefined) {
    const answer = answers.find((entry) => String(entry?.id) === String(review.id));
    const selected = Array.isArray(answer?.selected) ? answer.selected : [];
    return selected.includes(planReviewApproveLabel(review)) ? 'approve' : 'reject';
  }
  return 'answer';
}

/** Validate and strip a policy result down to the wire answer shape. */
function toWireAnswer(policyResult, questionIds) {
  if (policyResult === null || typeof policyResult !== 'object') throw new TypeError('questionPolicy returned no answer');
  if (policyResult.cancelled === true) return { cancelled: true };
  if (!Array.isArray(policyResult.answers)) throw new TypeError('questionPolicy must resolve {answers} or {cancelled:true}');
  const seen = new Set();
  const answers = policyResult.answers.map((answer) => {
    if (answer === null || typeof answer !== 'object' || typeof answer.id !== 'string') {
      throw new TypeError('questionPolicy answers require string ids');
    }
    if (!Array.isArray(answer.selected) || !answer.selected.every((label) => typeof label === 'string')) {
      throw new TypeError(`questionPolicy answer ${answer.id} requires a selected string array`);
    }
    if (answer.custom !== undefined && typeof answer.custom !== 'string') {
      throw new TypeError(`questionPolicy answer ${answer.id} custom must be a string`);
    }
    if (seen.has(answer.id)) throw new TypeError(`questionPolicy answered ${answer.id} more than once`);
    seen.add(answer.id);
    const wire = { id: answer.id, selected: [...answer.selected] };
    if (answer.custom !== undefined) wire.custom = answer.custom;
    return wire;
  });
  const expected = new Set(questionIds.map((id) => String(id)));
  if (answers.length !== expected.size) throw new TypeError('questionPolicy did not answer every question id exactly once');
  for (const answer of answers) {
    if (!expected.has(answer.id)) throw new TypeError(`questionPolicy answered an unknown question id: ${answer.id}`);
  }
  return { answers };
}

/**
 * Drive one SDK session to completion.
 *
 * @param {object} options
 * @param {string} options.command executable to spawn (the DSH app CLI)
 * @param {string[]} options.args CLI arguments (profile + patches)
 * @param {string} options.cwd working directory for the child (the task worktree)
 * @param {Record<string,string>|undefined} options.env child environment
 * @param {{provider: string, model: string, reasoningEffort?: string|null, maxTokens?: number|null}} options.model
 * @param {string} options.sessionId SDK session id
 * @param {string} options.inputText the single text block to send
 * @param {(request: object) => Promise<object>} options.questionPolicy
 * @param {number} [options.timeoutMs]
 * @param {number} [options.idleSettleMs]
 * @param {Function} [options.spawnImpl] injectable `spawn`
 * @param {(frame: object) => void} [options.onFrame] streaming wire observer
 * @param {number} [options.shutdownGraceMs]
 * @returns {Promise<object>} session result; never throws for expected failures
 */
export function runSdkSession(options = {}) {
  const {
    command,
    args = [],
    cwd,
    env,
    model = {},
    sessionId,
    inputText,
    questionPolicy,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    idleSettleMs = DEFAULT_IDLE_SETTLE_MS,
    spawnImpl = spawn,
    onFrame,
    shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  } = options;

  const startedAt = nowIso();
  let contentBlocks;
  try {
    contentBlocks = planContentBlocks(inputText);
  } catch (error) {
    return Promise.resolve({
      frames: [],
      questions: [],
      response: null,
      completion: null,
      exitCode: null,
      stderrTail: '',
      startedAt,
      endedAt: nowIso(),
      timedOut: false,
      errors: [{ kind: 'input', message: messageOf(error) }],
      warnings: [],
    });
  }
  const frames = [];
  const questions = [];
  const errors = [];
  const warnings = [];
  const pending = new Map();
  let child = null;
  let stderr = '';
  let stdoutBuffer = '';
  let response = null;
  let completion = null;
  let exitCode = null;
  let exited = false;
  let settled = false;
  let timedOut = false;
  let lastStatus = null;
  let sawTurnEnd = false;
  let pendingQuestions = 0;
  let rpcSeq = 0;
  let idleTimer = null;
  let overallTimer = null;
  let exitWaiters = [];

  return new Promise((resolve) => {
    function result() {
      return {
        frames,
        questions,
        response,
        completion,
        exitCode,
        stderrTail: stderr.slice(-STDERR_TAIL_CHARS),
        startedAt,
        endedAt: nowIso(),
        timedOut,
        errors,
        warnings,
      };
    }

    function clearTimers() {
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (overallTimer !== null) clearTimeout(overallTimer);
      idleTimer = null;
      overallTimer = null;
    }

    function emitFrame(dir, kind, fields) {
      const row = { ts: nowIso(), dir, kind, ...fields };
      frames.push(row);
      try {
        onFrame?.(row);
      } catch (error) {
        errors.push({ kind: 'on-frame', message: messageOf(error) });
      }
      return row;
    }

    function writeLine(message) {
      if (child === null) throw new Error('SDK child is not available');
      const stream = child.stdin;
      if (stream === null || stream === undefined) throw new Error('SDK child stdin is unavailable');
      if (stream.destroyed === true) throw new Error('SDK child stdin is closed');
      stream.write(`${JSON.stringify(message)}\n`);
    }

    function sendRequest(method, params) {
      const id = `rpc_${++rpcSeq}`;
      emitFrame('out', 'request', { id, method, payload: params });
      return new Promise((resolveRequest, rejectRequest) => {
        // Register before writing: a fast peer can answer within the write call.
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, method });
        try {
          writeLine({ jsonrpc: '2.0', id, method, params });
        } catch (error) {
          pending.delete(id);
          errors.push({ kind: 'stdin', method, message: messageOf(error) });
          rejectRequest(error);
        }
      });
    }

    function sendResult(id, value) {
      emitFrame('out', 'response', { id, payload: { result: value } });
      try {
        writeLine({ jsonrpc: '2.0', id, result: value });
      } catch (error) {
        errors.push({ kind: 'stdin', method: 'response', message: messageOf(error) });
      }
    }

    function sendError(id, code, message) {
      emitFrame('out', 'response', { id, payload: { error: { code, message } } });
      try {
        writeLine({ jsonrpc: '2.0', id, error: { code, message } });
      } catch (error) {
        errors.push({ kind: 'stdin', method: 'error-response', message: messageOf(error) });
      }
    }

    function idleEligible() {
      if (settled || pendingQuestions > 0 || response === null) return false;
      if (response.kind === 'prompt') return true;
      return sawTurnEnd;
    }

    function touchIdle() {
      if (!idleEligible()) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (settled || pendingQuestions > 0) return;
        if (lastStatus !== 'idle') {
          touchIdle();
          return;
        }
        warnings.push(`observed idle for ${idleSettleMs}ms without session.query.completed`);
        finishSettled(true);
      }, idleSettleMs);
      idleTimer.unref?.();
    }

    function waitExit(ms) {
      if (exited) return Promise.resolve(true);
      return new Promise((resolveWait) => {
        const timer = setTimeout(() => resolveWait(false), ms);
        exitWaiters.push(() => {
          clearTimeout(timer);
          resolveWait(true);
        });
      });
    }

    function safeEndStdin() {
      try {
        child?.stdin?.end?.();
      } catch {
        // stdin already closed
      }
    }

    function killChild() {
      if (child === null) return;
      // A real ChildProcess records its spawnfile; injected fakes fall back to
      // kill() so a fake pid can never signal an unrelated process group.
      if (typeof child.spawnfile === 'string' && Number.isInteger(child.pid) && child.pid > 0 && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // fall through to the direct kill
        }
      }
      try {
        child.kill?.('SIGKILL');
      } catch {
        // already gone
      }
    }

    function withTimeout(promise, ms, label) {
      let timer = null;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      });
      return Promise.race([promise, timeout]).finally(() => {
        if (timer !== null) clearTimeout(timer);
      });
    }

    async function shutdownAndResolve(graceful) {
      try {
        if (child !== null && !exited) {
          if (graceful) {
            try {
              await withTimeout(sendRequest('shutdown', {}), shutdownGraceMs, 'shutdown RPC');
            } catch (error) {
              warnings.push(`shutdown RPC failed: ${messageOf(error)}`);
            }
          }
          safeEndStdin();
          if (!graceful || !(await waitExit(shutdownGraceMs))) {
            killChild();
            await waitExit(1000);
          }
        }
      } finally {
        clearTimers();
        resolve(result());
      }
    }

    function finishSettled(graceful) {
      if (settled) return;
      settled = true;
      clearTimers();
      void shutdownAndResolve(graceful);
    }

    function recordQuestion(row) {
      questions.push(row);
    }

    async function handleServerRequest(id, method, params) {
      if (method === 'user-question/ask') {
        pendingQuestions += 1;
        const requestId = typeof params.requestId === 'string' ? params.requestId : String(id);
        const asked = Array.isArray(params.questions) ? params.questions : [];
        const questionIds = asked.map((question) => String(question?.id));
        let decision = 'answer';
        let answers = [];
        let capHit = false;
        let errorText = null;
        try {
          if (typeof questionPolicy !== 'function') throw new Error('no question policy is configured');
          const policyResult = await questionPolicy({
            requestId,
            sessionId: params.sessionId,
            questions: asked,
          });
          const wire = toWireAnswer(policyResult, questionIds);
          decision = classifyQuestionDecision(asked, wire);
          answers = wire.cancelled === true ? [] : wire.answers;
          capHit = policyResult?.capHit === true;
          sendResult(id, wire);
        } catch (error) {
          errorText = messageOf(error);
          decision = 'reject';
          errors.push({ kind: 'question-policy', requestId, message: errorText });
          sendError(id, -32603, errorText);
        } finally {
          pendingQuestions = Math.max(0, pendingQuestions - 1);
          recordQuestion({
            ts: nowIso(),
            requestId,
            questions: asked,
            decision,
            answers,
            capHit,
            ...(errorText === null ? {} : { error: errorText }),
          });
          touchIdle();
        }
        return;
      }
      if (method === 'approval/request') {
        sendResult(id, { outcome: 'rejected' });
        return;
      }
      errors.push({ kind: 'unsupported-request', method });
      sendError(id, -32601, `unsupported server request: ${method}`);
    }

    function handleNotification(method, params) {
      if (method === 'session.query.completed') {
        if (params?.sessionId !== sessionId) return;
        const expectedCommandId = response?.execution?.commandId;
        if (expectedCommandId !== undefined && params?.commandId !== undefined && params.commandId !== expectedCommandId) return;
        completion = params;
        finishSettled(true);
        return;
      }
      if (method === 'session.status') {
        if (params?.sessionId === sessionId) lastStatus = params.status;
        return;
      }
      if (method === 'session.event') {
        const event = params?.event;
        if (params?.sessionId === sessionId && event !== null && typeof event === 'object' && event.type === 'turn/end') {
          sawTurnEnd = true;
        }
        return;
      }
      // user-question.cancelled and subagent/lifecycle notifications are
      // recorded in the wire transcript but need no driver action.
    }

    function handleLine(line) {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        errors.push({ kind: 'malformed', line: line.slice(0, 300) });
        return;
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        errors.push({ kind: 'malformed', line: line.slice(0, 300) });
        return;
      }
      const id = message.id;
      const method = message.method;
      const hasId = typeof id === 'string' || typeof id === 'number';
      if (hasId && typeof method === 'string') {
        const params = message.params !== null && typeof message.params === 'object' ? message.params : {};
        emitFrame('in', 'request', { id, method, payload: params });
        void handleServerRequest(id, method, params).catch((error) => {
          errors.push({ kind: 'internal', method, message: messageOf(error) });
        });
        touchIdle();
        return;
      }
      if (hasId) {
        const payload =
          message.error !== undefined && message.error !== null && typeof message.error === 'object'
            ? { error: message.error }
            : { result: message.result };
        emitFrame('in', 'response', { id, payload });
        const waiter = pending.get(id);
        if (waiter === undefined) {
          warnings.push(`unexpected response id: ${String(id)}`);
          touchIdle();
          return;
        }
        pending.delete(id);
        if (payload.error !== undefined) {
          const error = new Error(
            typeof payload.error.message === 'string' ? payload.error.message : 'JSON-RPC request failed',
          );
          error.code = payload.error.code;
          waiter.reject(error);
        } else {
          if (waiter.method === 'session/query') response = message.result;
          waiter.resolve(message.result);
        }
        touchIdle();
        return;
      }
      if (typeof method === 'string') {
        const params = message.params !== null && typeof message.params === 'object' ? message.params : {};
        emitFrame('in', 'notification', { method, payload: params });
        handleNotification(method, params);
        touchIdle();
        return;
      }
      errors.push({ kind: 'malformed', line: line.slice(0, 300) });
    }

    function onStdout(chunk) {
      stdoutBuffer += typeof chunk === 'string' ? chunk : String(chunk);
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line !== '') handleLine(line);
      }
    }

    function onStderr(chunk) {
      stderr += typeof chunk === 'string' ? chunk : String(chunk);
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-512 * 1024);
    }

    function onClose(code, signal) {
      exited = true;
      exitCode = typeof code === 'number' ? code : null;
      if (stdoutBuffer.trim() !== '') {
        const line = stdoutBuffer.trim();
        stdoutBuffer = '';
        handleLine(line);
      }
      const waiters = exitWaiters;
      exitWaiters = [];
      for (const waiter of waiters) waiter();
      if (settled) return;
      errors.push({ kind: 'process-exit', code: exitCode, signal: signal ?? null });
      finishSettled(false);
    }

    function attachChild() {
      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.on('error', (error) => {
        errors.push({ kind: 'spawn', message: messageOf(error) });
        finishSettled(false);
      });
      child.on('close', onClose);
      child.on('exit', (code, signal) => {
        if (!exited) exitCode = typeof code === 'number' ? code : null;
        void signal;
      });
      if (typeof child.stdin?.on === 'function') child.stdin.on('error', () => {});
    }

    async function runConversation() {
      let initialize;
      try {
        initialize = await sendRequest('initialize', buildInitializeParams());
      } catch (error) {
        if (!settled) {
          errors.push({ kind: 'rpc', method: 'initialize', code: error.code, message: messageOf(error) });
          finishSettled(false);
        }
        return;
      }
      if (initialize === undefined) return;
      if (settled) return;
      try {
        response = await sendRequest('session/query', {
          sessionId,
          contentBlocks,
        });
      } catch (error) {
        if (!settled) {
          errors.push({ kind: 'rpc', method: 'session/query', code: error.code, message: messageOf(error) });
          finishSettled(false);
        }
        return;
      }
      touchIdle();
    }

    function buildInitializeParams() {
      const params = {
        cwd: cwd ?? process.cwd(),
        provider: model.provider,
        model: model.model,
        capabilities: { userQuestions: true },
        approvalRequests: false,
      };
      if (typeof model.reasoningEffort === 'string' && model.reasoningEffort !== '') {
        params.reasoningEffort = model.reasoningEffort;
      }
      if (Number.isSafeInteger(model.maxTokens) && model.maxTokens > 0) params.maxTokens = model.maxTokens;
      return params;
    }

    // Spawn.
    try {
      child = spawnImpl(command, args, {
        cwd,
        env: env === undefined ? process.env : env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      errors.push({ kind: 'spawn', message: messageOf(error) });
      resolve({
        frames,
        questions,
        response: null,
        completion: null,
        exitCode: null,
        stderrTail: '',
        startedAt,
        endedAt: nowIso(),
        timedOut: false,
        errors,
        warnings,
      });
      return;
    }
    if (child === null || typeof child !== 'object') {
      errors.push({ kind: 'spawn', message: 'spawn implementation returned no child process' });
      resolve({
        frames,
        questions,
        response: null,
        completion: null,
        exitCode: null,
        stderrTail: '',
        startedAt,
        endedAt: nowIso(),
        timedOut: false,
        errors,
        warnings,
      });
      return;
    }

    attachChild();
    overallTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      errors.push({ kind: 'timeout', message: `SDK session timed out after ${timeoutMs}ms` });
      finishSettled(false);
    }, timeoutMs);
    overallTimer.unref?.();
    void runConversation().catch((error) => {
      errors.push({ kind: 'internal', message: messageOf(error) });
      finishSettled(false);
    });
  });
}
