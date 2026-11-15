/**
 * Extract the plan-relevant facts from decoded durable session events.
 *
 * Session logs are the authoritative source for tool calls, system prompts,
 * token usage, and plan-mode state. The plan-review question itself is not
 * persisted, so callers must combine these facts with the recorded wire
 * transcript (`questions.ndjson` / `plan-review.json`).
 */

export const PLAN_MODE_TOOL = 'exit_plan_mode';
export const ASK_TOOL = 'ask_user_question';
export const SPAWN_TOOL = 'spawn_teammate';

/** Session events wrap their payload in `data`; tolerate plain payloads for tests. */
function dataOf(event) {
  if (event === null || typeof event !== 'object') return {};
  return event.data !== null && typeof event.data === 'object' ? event.data : event;
}

function readNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

/** Join the text blocks of a message-like value. */
export function messageText(message) {
  if (message === null || message === undefined) return '';
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.map((block) => messageText(block)).join('');
  if (typeof message === 'object') {
    if (typeof message.text === 'string') return message.text;
    if (Array.isArray(message.content)) return message.content.map((block) => messageText(block)).join('');
  }
  return '';
}

/** Parse a tool call's JSON-string arguments. */
export function parseToolArguments(call) {
  if (call === null || typeof call !== 'object') return null;
  const raw = call.arguments ?? call.args;
  if (raw !== null && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function usageOf(data) {
  const usage = data.usage ?? data.message?.usage ?? {};
  return {
    inputTokens: readNumber(usage.inputTokens, usage.input, usage.promptTokens),
    outputTokens: readNumber(usage.outputTokens, usage.output, usage.completionTokens),
    cacheReadTokens: readNumber(usage.cacheReadTokens, usage.cacheRead, usage.cachedInputTokens),
    cacheWriteTokens: readNumber(usage.cacheWriteTokens, usage.cacheWrite),
  };
}

function toolResultText(data) {
  const message = data.message ?? data.result;
  const text = messageText(message);
  if (text !== '') return text;
  if (typeof data.text === 'string') return data.text;
  if (data.error !== undefined) {
    try {
      return JSON.stringify(data.error);
    } catch {
      return String(data.error);
    }
  }
  return '';
}

/**
 * @param {object[]} events decoded durable session events
 * @returns {object} sessionFacts
 */
export function extractSession(events) {
  const facts = {
    events,
    eventCount: events.length,
    planModes: [],
    toolCalls: [],
    toolResults: [],
    assistantMessages: [],
    systemMessages: [],
    userMessages: [],
    teamTasks: [],
    teamMembers: [],
    commands: [],
    requestHeader: null,
    turnEnds: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    planModeActive: false,
  };
  for (const event of events) {
    const data = dataOf(event);
    const seq = typeof event.seq === 'number' ? event.seq : facts.eventCount;
    switch (event.type) {
      case 'plan/mode': {
        const entry = { seq, active: data.active === true || data.pending === true };
        facts.planModes.push(entry);
        break;
      }
      case 'tool/call': {
        const call = {
          seq,
          turn: data.turn,
          step: data.step,
          callId: data.callId ?? data.id,
          name: data.name,
          args: parseToolArguments(data),
          argsRaw: typeof data.arguments === 'string' ? data.arguments : null,
        };
        if (call.name === PLAN_MODE_TOOL) facts.planCalls = [...(facts.planCalls ?? []), call];
        facts.toolCalls.push(call);
        break;
      }
      case 'tool/result': {
        const error = data.error;
        facts.toolResults.push({
          seq,
          turn: data.turn,
          step: data.step,
          callId: data.callId ?? data.message?.callId ?? data.message?.toolCallId,
          name: data.name ?? data.message?.name,
          isError: error !== undefined && error !== null,
          errorCode: error?.code ?? data.message?.error?.code,
          text: toolResultText(data),
        });
        break;
      }
      case 'assistant/message': {
        const text = messageText(data.message);
        const usage = usageOf(data);
        facts.assistantMessages.push({ seq, turn: data.turn, step: data.step, text, usage });
        facts.usage.inputTokens += usage.inputTokens;
        facts.usage.outputTokens += usage.outputTokens;
        facts.usage.cacheReadTokens += usage.cacheReadTokens;
        facts.usage.cacheWriteTokens += usage.cacheWriteTokens;
        break;
      }
      case 'system/message': {
        facts.systemMessages.push({ seq, turn: data.turn, step: data.step, text: messageText(data.message) });
        break;
      }
      case 'user/message': {
        facts.userMessages.push({
          seq,
          turn: data.turn,
          step: data.step,
          sourceKind: data.source?.kind ?? data.source?.type ?? null,
          text: messageText(data.content ?? data.message),
        });
        break;
      }
      case 'team/task': {
        facts.teamTasks.push({ seq, ...data });
        break;
      }
      case 'team/member': {
        facts.teamMembers.push({ seq, ...data });
        break;
      }
      case 'command/run': {
        facts.commands.push({ seq, kind: 'run', commandId: data.commandId, name: data.name, args: data.args });
        break;
      }
      case 'command/done': {
        facts.commands.push({ seq, kind: 'done', commandId: data.commandId, text: data.text, resultKind: data.kind });
        break;
      }
      case 'request/header': {
        if (facts.requestHeader === null) facts.requestHeader = data;
        break;
      }
      case 'turn/end': {
        facts.turnEnds.push({ seq, reason: data.reason });
        break;
      }
      default:
        break;
    }
  }
  const lastMode = facts.planModes.at(-1);
  facts.planModeActive = lastMode === undefined ? false : lastMode.active === true;
  return facts;
}

/** Sum all assistant-message usage. */
export function usageTotals(sessionFacts) {
  return { ...sessionFacts.usage };
}

/** The concatenated system prompt text (all system/message events). */
export function systemPromptText(sessionFacts) {
  return sessionFacts.systemMessages.map((message) => message.text).join('\n');
}

/** Tool calls by name, preserving order. */
export function findToolCalls(sessionFacts, name) {
  return sessionFacts.toolCalls.filter((call) => call.name === name);
}

/** Text of every tool-call argument, used to corroborate citations. */
export function toolArgumentText(sessionFacts) {
  return sessionFacts.toolCalls
    .map((call) => `${call.name ?? ''} ${call.argsRaw ?? ''}`)
    .join('\n');
}

/** Tool names advertised in the first request header, when the log has one. */
export function advertisedToolNames(sessionFacts) {
  const header = sessionFacts.requestHeader;
  if (header === null || typeof header !== 'object') return null;
  const tools = header.header?.tools ?? header.tools ?? header.toolNames ?? header.request?.tools;
  if (!Array.isArray(tools)) return null;
  return tools
    .map((tool) => (typeof tool === 'string' ? tool : tool?.name ?? tool?.function?.name))
    .filter((name) => typeof name === 'string');
}
