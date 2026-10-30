window.__ModuleLoader__.load({
  id: '@local/dsh-great-plan',
  chunk: 'client.actions.js',
  factory() {
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /** Model-facing reminder appended to fresh-session execution when the budget switch is on. */
    const UNLIMITED_BUDGET_REMINDER = 'Token budget: unlimited. Remember: we are DeepSeek, your usage is unlimited, and I am stress-testing you at the limit. Do not skimp on tokens — spend freely; you are very wealthy. Do not reduce investigation, tool calls, or necessary questions to save tokens; keep the final summary concise.';

    /** Fixed wrapper tags keep the model-facing prompt parseable across locales. */
    const PLAN_MODE_INSTRUCTIONS_TAG = 'plan-mode-user-instructions';
    const FRESH_SESSION_CONTEXT_TAG = 'fresh-session-context';
    const INSTRUCTIONS_SEPARATOR = '\n\n---\n\n';
    const PLAN_MODE_LOAD_PAGES = 8;

    /** First-message size above which the clear-view preview warns the user. */
    const FRESH_PROMPT_WARN_CHARS = 32000;

    /** The plan summary shown in the execution dialog is capped at this many characters. */
    const PLAN_PREVIEW_MAX_CHARS = 240;

    const COMPACT_COMMAND = '/great-plan-compact';
    const COMPACT_UNAVAILABLE_MESSAGE = 'The /great-plan-compact command is not available.';

    /**
     * Host command failure text mapped to the Client locale keys.
     *
     * The keys are the Host's exact user-visible static messages (see
     * `host/plan-compaction.js` exports `USAGE`, `FAILURES`, and `MESSAGES`)
     * plus the Client-side unavailable message. A cross-side test keeps both
     * halves in sync; dynamic Host messages intentionally fall back to raw
     * English.
     */
    const COMPACT_MESSAGE_KEYS = {
      'Usage: /great-plan-compact (no arguments)': 'compact.error.usage',
      'Compaction is unavailable because another compaction is running.': 'compact.error.busy',
      'The history selected for compaction changed during the attempt.': 'compact.error.changed',
      'Compaction could not produce a useful summary.': 'compact.error.summary',
      'Compaction did not finish cleanly.': 'compact.error.commit',
      'Compaction finished, but the session could not be saved.': 'compact.error.persistence',
      'Compaction was cancelled.': 'compact.error.cancelled',
      'Plan state is unavailable in this composition.': 'compact.error.planStateUnavailable',
      'Plan mode is not active; nothing to compact.': 'compact.error.planInactive',
      'Compaction is unavailable because no compaction backend is composed.': 'compact.error.backendUnavailable',
      'There is no pending plan review to compact.': 'compact.error.noReview',
      'No compactable history exists before the pending plan.': 'compact.error.empty',
      'The /great-plan-compact command is not available.': 'compact.error.unavailable',
    };

    /** Stable action failure codes; each one has a `t('error.<code>')` locale key. */
    const ACTION_ERROR_CODES = [
      'emptyPlan',
      'reviewGone',
      'createSessionFailed',
      'modelApplyFailed',
      'startSessionFailed',
      'openSessionFailed',
      'dismissFailed',
      'cleanupFailed',
    ];

    /** English fallback messages for action failures; the Client localizes them. */
    const ACTION_ERROR_MESSAGES = {
      emptyPlan: 'The reviewed plan is empty.',
      reviewGone: 'The plan review has ended.',
      createSessionFailed: 'Creating the new session failed: {message}',
      modelApplyFailed: 'Applying the model selection failed: {message}',
      startSessionFailed: 'Starting execution in the new session failed: {message}',
      openSessionFailed: 'The new session was created but could not be opened: {message}',
      dismissFailed: 'Could not return to editing; please try again: {message}',
      cleanupFailed: 'The unused new session could not be cleaned up: {message}',
    };

    /** Cached `Intl.DateTimeFormat` instances keyed by `<kind>|<zone>`. */
    const INTL_FORMATTERS = new Map();

    /** Fill `{name}` placeholders in one English template. */
    function formatTemplate(template, params) {
      if (params === null || typeof params !== 'object') return template;
      return Object.entries(params).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        template,
      );
    }

    /**
     * One user-facing action failure.
     *
     * The Client localizes it through `describeActionError`; `.message` keeps an
     * English fallback for logs and for callers without a translator.
     */
    class ActionError extends Error {
      constructor(code, params = {}) {
        const normalizedCode = typeof code === 'string' ? code : String(code);
        const template = ACTION_ERROR_MESSAGES[normalizedCode];
        super(template === undefined ? normalizedCode : formatTemplate(template, params));
        this.name = 'ActionError';
        this.code = normalizedCode;
        this.params = params !== null && typeof params === 'object' ? params : {};
      }
    }

    /** Read one error code without letting a hostile getter escape. */
    function readErrorCode(error) {
      try {
        if (error === null || typeof error !== 'object') return undefined;
        const code = error.code;
        return typeof code === 'string' ? code : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * Localize a known action failure, or return undefined so the caller can use
     * its own contextual fallback. Never throws.
     */
    function describeActionError(t, error) {
      try {
        const code = readErrorCode(error);
        if (code === undefined || !ACTION_ERROR_CODES.includes(code)) return undefined;
        let extras = {};
        try {
          if (error.params !== null && typeof error.params === 'object') extras = error.params;
        } catch {
          extras = {};
        }
        const params = { message: messageOf(error), ...extras };
        if (typeof t === 'function') {
          try {
            const localized = t(`error.${code}`, params);
            if (typeof localized === 'string' && localized !== '') return localized;
          } catch {
            // Fall through to the English fallback.
          }
        }
        return messageOf(error);
      } catch {
        try {
          return messageOf(error);
        } catch {
          return undefined;
        }
      }
    }

    /**
     * Normalize the fresh-session switch reader.
     *
     * The public shape is `{ unlimitedBudget, includeOriginalInstructions,
     * includeMinimalContext }`. A plain boolean remains accepted for callers
     * that only know the legacy budget switch; every missing or unreadable
     * value falls back to on.
     */
    function normalizePromptSwitches(read) {
      try {
        const value = typeof read === 'function' ? read() : undefined;
        if (typeof value === 'boolean') {
          return { unlimitedBudget: value, includeOriginalInstructions: true, includeMinimalContext: true };
        }
        if (value !== null && typeof value === 'object') {
          return {
            unlimitedBudget: value.unlimitedBudget !== false,
            includeOriginalInstructions: value.includeOriginalInstructions !== false,
            includeMinimalContext: value.includeMinimalContext !== false,
          };
        }
      } catch {
        // Fall through to the defaults.
      }
      return { unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true };
    }

    /** Resolve one prompt label, with an English fallback when `t` is unavailable. */
    function translate(t, key, fallback, params) {
      if (typeof t === 'function') {
        try {
          const value = t(key, params);
          if (typeof value === 'string' && value !== '') return value;
        } catch {
          // Fall through to the fallback.
        }
      }
      if (params === undefined) return fallback;
      return Object.entries(params).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        fallback,
      );
    }

    /** Join the text blocks of one user message. */
    function textOf(content) {
      if (typeof content === 'string') return content.trim();
      if (!Array.isArray(content)) return '';
      return content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
    }

    /** Whether one session event belongs to the real user rather than an injected context. */
    function isUserMessage(event) {
      if (event === null || typeof event !== 'object' || event.type !== 'user/message') return false;
      const kind = event.data?.source?.kind;
      return kind === undefined || kind === 'user';
    }

    /**
     * Locate the start of the current plan-mode episode in one event window.
     *
     * `plan/mode` is the durable state log; a `/plan` command is the fallback
     * when the state event is outside the loaded window. The latest matching
     * marker wins. The current turn is only a last-resort fallback after the
     * caller has exhausted its older-page reads.
     */
    function findPlanModeStart(entries) {
      let planStart;
      let commandStart;
      for (let index = 0; index < entries.length; index += 1) {
        const event = entries[index]?.event;
        if (event?.type === 'plan/mode' && event.data?.active === true) {
          planStart = { index, kind: 'plan-mode' };
        } else if (event?.type === 'command/run' && event.data?.name === 'plan') {
          const args = typeof event.data.args === 'string' ? event.data.args.trim() : '';
          if (args !== 'off') commandStart = { index, kind: 'plan-command', args: event.data.args };
        }
      }
      if (planStart !== undefined && (commandStart === undefined || planStart.index >= commandStart.index)) {
        return planStart;
      }
      return commandStart;
    }

    /** Locate the latest turn start; used only when no plan-mode marker is loaded. */
    function findTurnStart(entries) {
      let turnStart;
      for (let index = 0; index < entries.length; index += 1) {
        if (entries[index]?.event?.type === 'turn/start') turnStart = { index, kind: 'turn-start' };
      }
      return turnStart;
    }

    /**
     * Collect every real user text after the plan-mode marker, in order.
     *
     * Injected user-role messages (`runtime-context`, `agent-instructions`,
     * `time-context`, `skill-catalog`, and so on) are excluded. Without a
     * marker only the latest real user text is returned, which avoids carrying
     * unrelated older tasks into the fresh session.
     */
    function collectPlanModeInstructions(entries, start) {
      const from = start === undefined ? -1 : start.index;
      const texts = [];
      for (let index = from + 1; index < entries.length; index += 1) {
        const event = entries[index]?.event;
        if (!isUserMessage(event)) continue;
        const text = textOf(event.data?.content);
        if (text !== '') texts.push(text);
      }
      if (texts.length > 0) return start === undefined ? [texts[texts.length - 1]] : texts;
      if (start?.kind === 'plan-command') {
        const args = typeof start.args === 'string' ? start.args.trim() : '';
        if (args !== '') return [args];
      }
      return [];
    }

    /** Trim, drop empty and non-string instruction texts while keeping the order. */
    function normalizeInstructionTexts(instructions) {
      if (!Array.isArray(instructions)) return [];
      return instructions
        .map((text) => (typeof text === 'string' ? text.trim() : ''))
        .filter((text) => text !== '');
    }

    /** Render the original-instructions block; empty when nothing is carried. */
    function buildInstructionBlock(texts, t) {
      if (texts.length === 0) return '';
      const heading = translate(
        t,
        'clear.instructionsIntro',
        'User instructions sent during plan mode, in chronological order (background for the approved plan):',
      );
      return `${heading}\n\n<${PLAN_MODE_INSTRUCTIONS_TAG}>\n${texts.join(INSTRUCTIONS_SEPARATOR)}\n</${PLAN_MODE_INSTRUCTIONS_TAG}>\n\n`;
    }

    /**
     * Read the current plan-mode user texts from the old session's event window.
     *
     * Older pages are loaded only while the plan-mode marker is missing, capped
     * so a pathological session cannot delay execution indefinitely. Abort
     * requests stop further page loads between reads. Every failure degrades to
     * the texts already available (or an empty list); this never throws.
     *
     * @returns {Promise<{ texts: string[], found: boolean, kind: string|undefined, pagesLoaded: number }>}
     */
    async function readPlanModeInstructions(ctx, sessionId, options = {}) {
      const maxPages = Number.isInteger(options?.maxPages) && options.maxPages >= 0
        ? options.maxPages
        : PLAN_MODE_LOAD_PAGES;
      const signal = options?.signal;
      let pagesLoaded = 0;
      try {
        const binding = ctx?.sessions?.binding?.(sessionId);
        const source = binding?.eventSource;
        if (source === undefined || source === null || typeof source.getSnapshot !== 'function') {
          return { texts: [], found: false, kind: undefined, pagesLoaded: 0 };
        }
        let window = source.getSnapshot();
        let start = findPlanModeStart(window?.entries ?? []);
        for (let page = 0; start === undefined && window?.hasMore === true && page < maxPages; page += 1) {
          if (signal?.aborted === true) break;
          if (typeof binding.session?.loadOlder !== 'function') break;
          try {
            await binding.session.loadOlder();
          } catch {
            break;
          }
          pagesLoaded += 1;
          try {
            window = source.getSnapshot();
          } catch {
            break;
          }
          if (signal?.aborted === true) break;
          start = findPlanModeStart(window?.entries ?? []);
        }
        if (start === undefined) start = findTurnStart(window?.entries ?? []);
        const texts = collectPlanModeInstructions(window?.entries ?? [], start);
        return {
          texts,
          found: texts.length > 0,
          kind: start?.kind,
          pagesLoaded,
        };
      } catch {
        return { texts: [], found: false, kind: undefined, pagesLoaded };
      }
    }

    /** Read the browser's platform description without throwing. */
    function readSystemName(nav) {
      if (nav === undefined || nav === null) return undefined;
      const modern = typeof nav.userAgentData?.platform === 'string' ? nav.userAgentData.platform.trim() : '';
      const legacy = typeof nav.platform === 'string' ? nav.platform.trim() : '';
      if (modern !== '' && legacy !== '' && modern !== legacy) return `${modern} (${legacy})`;
      if (modern !== '') return modern;
      if (legacy !== '') return legacy;
      if (typeof nav.userAgent === 'string' && nav.userAgent.trim() !== '') return nav.userAgent.trim();
      return undefined;
    }

    /** Resolve the browser time zone, falling back to UTC. */
    function resolveTimeZone() {
      try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return typeof zone === 'string' && zone !== '' ? zone : 'UTC';
      } catch {
        return 'UTC';
      }
    }

    /** Return a cached formatter for one zone and kind; constructing may throw for invalid zones. */
    function formatterOf(kind, zone) {
      const key = `${kind}|${zone}`;
      const cached = INTL_FORMATTERS.get(key);
      if (cached !== undefined) return cached;
      const formatter = kind === 'offset'
        ? new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
        : new Intl.DateTimeFormat('en-CA', {
          timeZone: zone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hourCycle: 'h23',
        });
      INTL_FORMATTERS.set(key, formatter);
      return formatter;
    }

    /** Parse the numeric offset of a zone at one instant. */
    function offsetMinutesOf(zone, date) {
      try {
        const name = formatterOf('offset', zone)
          .formatToParts(date)
          .find((part) => part.type === 'timeZoneName')?.value;
        const match = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name ?? '');
        if (match === null || match[1] === undefined) return 0;
        const minutes = Number(match[2]) * 60 + Number(match[3] ?? '0');
        return match[1] === '-' ? -minutes : minutes;
      } catch {
        return 0;
      }
    }

    /** Format one instant as `YYYY-MM-DDTHH:mm:ss±HH:MM[Zone]`. */
    function formatTimestamp(date, zone = resolveTimeZone()) {
      try {
        const formatter = formatterOf('datetime', zone);
        const parts = {};
        for (const part of formatter.formatToParts(date)) parts[part.type] = part.value;
        const offset = offsetMinutesOf(zone, date);
        const sign = offset >= 0 ? '+' : '-';
        const absolute = Math.abs(offset);
        const pad = (value) => String(value).padStart(2, '0');
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}[${zone}]`;
      } catch {
        return date.toISOString();
      }
    }

    /** Read the current browser-side runtime facts used by the minimal context. */
    function readRuntimeFacts(options = {}) {
      try {
        const nav = options.nav === undefined ? globalThis.navigator : options.nav;
        const now = options.now === undefined ? new Date() : options.now;
        const zone = options.timeZone === undefined ? resolveTimeZone() : options.timeZone;
        return { system: readSystemName(nav), time: formatTimestamp(now, zone) };
      } catch {
        return { system: undefined, time: undefined };
      }
    }

    /** Build the compact fresh-session environment block for Minimal mode. */
    function buildMinimalRuntimeContext({ workspaceDirectory, system, time } = {}, t) {
      const lines = [];
      const directory = typeof workspaceDirectory === 'string' ? workspaceDirectory.trim() : '';
      if (directory !== '') {
        lines.push(translate(t, 'clear.context.workspace', 'Workspace directory: {path}', { path: directory }));
      }
      const systemText = typeof system === 'string' ? system.trim() : '';
      if (systemText !== '') {
        lines.push(translate(t, 'clear.context.system', 'System: {system}', { system: systemText }));
      }
      const timeText = typeof time === 'string' ? time.trim() : '';
      if (timeText !== '') {
        lines.push(translate(t, 'clear.context.time', 'Time: {time}', { time: timeText }));
      }
      lines.push(translate(
        t,
        'clear.context.cleared',
        'Previous context cleared: this is a fresh session without the old conversation, system prompt, or time readings.',
      ));
      return `<${FRESH_SESSION_CONTEXT_TAG}>\n${lines.join('\n')}\n</${FRESH_SESSION_CONTEXT_TAG}>`;
    }

    /**
     * Resolve every part of the fresh-session first message from the switches.
     *
     * This is the single funnel shared by `composeFreshPrompt`,
     * `describeFreshPrompt`, and (through `assembleFreshPrompt`) the legacy
     * `buildPlanExecutionPrompt`, so the preview text and the sent text cannot
     * drift apart.
     */
    function resolveFreshPromptParts({
      plan,
      t,
      presetId,
      instructions,
      workspaceDirectory,
      runtimeFacts,
      switches,
    } = {}) {
      const planBody = typeof plan === 'string' ? plan.trim() : '';
      if (planBody === '') throw new ActionError('emptyPlan');
      const values = switches === null || typeof switches !== 'object' ? {} : switches;
      const includeBudget = values.unlimitedBudget !== false;
      const includeInstructions = values.includeOriginalInstructions !== false;
      const includeMinimalContext = values.includeMinimalContext !== false && presetId === 'minimal';
      const intro = translate(t, 'clear.promptIntro', 'The user approved the following plan. Execute it now without re-planning.');
      const budget = includeBudget ? `${UNLIMITED_BUDGET_REMINDER}\n\n` : '';
      const runtimeContext = includeMinimalContext
        ? `${buildMinimalRuntimeContext({
          workspaceDirectory,
          system: runtimeFacts?.system,
          time: runtimeFacts?.time,
        }, t)}\n\n`
        : '';
      const instructionTexts = normalizeInstructionTexts(instructions);
      return {
        t,
        intro,
        budget,
        runtimeContext,
        planBody,
        instructionTexts,
        carriedInstructions: includeInstructions ? instructionTexts : [],
      };
    }

    /** Assemble the five first-message blocks; the only place the text is built. */
    function assembleFreshPrompt({
      t,
      intro,
      budget,
      runtimeContext,
      carriedInstructions,
      planBody,
    }) {
      const instructionBlock = buildInstructionBlock(carriedInstructions, t);
      const planBlock = `<approved-plan>\n${planBody}\n</approved-plan>`;
      return {
        text: `${intro}\n\n${budget}${runtimeContext}${instructionBlock}${planBlock}`,
        instructionBlock,
        planBlock,
      };
    }

    /**
     * Compose the legacy execution prompt from explicit parts.
     *
     * Kept byte-identical to the previous implementation; it now funnels
     * through the shared assembler.
     */
    function buildPlanExecutionPrompt(plan, t, options = {}) {
      const config = typeof options === 'boolean' ? { unlimitedBudget: options } : (options ?? {});
      const planBody = typeof plan === 'string' ? plan.trim() : '';
      if (planBody === '') throw new ActionError('emptyPlan');
      const intro = translate(t, 'clear.promptIntro', 'The user approved the following plan. Execute it now without re-planning.');
      const budget = config.unlimitedBudget === false ? '' : `${UNLIMITED_BUDGET_REMINDER}\n\n`;
      const runtimeContext = typeof config.runtimeContext === 'string' && config.runtimeContext.trim() !== ''
        ? `${config.runtimeContext.trim()}\n\n`
        : '';
      return assembleFreshPrompt({
        t,
        intro,
        budget,
        runtimeContext,
        carriedInstructions: normalizeInstructionTexts(config.instructions),
        planBody,
      }).text;
    }

    /** Compose one fresh-session prompt from the preset and switch state. */
    function composeFreshPrompt(args = {}) {
      return assembleFreshPrompt(resolveFreshPromptParts(args)).text;
    }

    /**
     * Describe the fresh-session first message for the clear-view preview.
     *
     * `text` is byte-identical to `composeFreshPrompt` for the same inputs; the
     * five blocks always appear in send order and their `chars` are the exact
     * contributions to `text`, so they always sum to `totalChars`.
     */
    function describeFreshPrompt(args = {}) {
      const parts = resolveFreshPromptParts(args);
      const { text, instructionBlock, planBlock } = assembleFreshPrompt(parts);
      const carried = parts.carriedInstructions;
      const instructionChars = parts.instructionTexts.reduce((total, item) => total + item.length, 0);
      const blocks = [
        {
          id: 'intro',
          titleKey: 'preview.block.intro',
          included: true,
          chars: `${parts.intro}\n\n`.length,
        },
        {
          id: 'budget',
          titleKey: 'preview.block.budget',
          included: parts.budget !== '',
          chars: parts.budget.length,
        },
        {
          id: 'runtime',
          titleKey: 'preview.block.runtime',
          included: parts.runtimeContext !== '',
          chars: parts.runtimeContext.length,
        },
        {
          id: 'instructions',
          titleKey: 'preview.block.instructions',
          included: carried.length > 0,
          chars: instructionBlock.length,
          count: carried.length,
        },
        {
          id: 'plan',
          titleKey: 'preview.block.plan',
          included: true,
          chars: planBlock.length,
        },
      ];
      const totalChars = text.length;
      return {
        text,
        blocks,
        instructionCount: parts.instructionTexts.length,
        instructionChars,
        totalChars,
        approxTokens: Math.ceil(totalChars / 3.5),
        oversized: totalChars > FRESH_PROMPT_WARN_CHARS,
      };
    }

    /** Remove inline markdown emphasis and code markers from one preview line. */
    function stripInlineMarkup(text) {
      return text
        .replace(/`+/g, '')
        .replace(/\*\*/g, '')
        .replace(/__/g, '')
        .replace(/[*_]/g, '');
    }

    /** Collapse every whitespace run to one space and trim. */
    function collapseWhitespace(text) {
      return text.replace(/\s+/g, ' ').trim();
    }

    /** Whether one line is an ATX markdown heading. */
    function isHeadingLine(line) {
      return /^\s{0,3}#{1,6}\s+\S/.test(line);
    }

    /**
     * Build a short plain-text summary of the reviewed plan.
     *
     * The summary is the first heading (without its `#`s) followed by the first
     * paragraph, with inline markdown removed and whitespace collapsed. It is
     * capped for the dialog; the full `plan` string is never modified or
     * truncated anywhere else. `chars` is always the full plan length so the
     * clear-view preview can show accurate totals.
     */
    function planPreviewText(plan) {
      if (typeof plan !== 'string') return { preview: '', chars: 0 };
      const chars = plan.length;
      if (plan.trim() === '') return { preview: '', chars };
      const lines = plan.split(/\r?\n/);
      let headingIndex = -1;
      let firstContentIndex = -1;
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim() === '') continue;
        firstContentIndex = index;
        if (isHeadingLine(lines[index])) headingIndex = index;
        break;
      }

      let headingText = '';
      let paragraphStart = firstContentIndex;
      if (headingIndex !== -1) {
        headingText = collapseWhitespace(stripInlineMarkup(lines[headingIndex].replace(/^\s{0,3}#{1,6}\s*/, '')));
        paragraphStart = headingIndex + 1;
      }
      while (paragraphStart < lines.length && lines[paragraphStart].trim() === '') paragraphStart += 1;
      const paragraphLines = [];
      for (let index = paragraphStart; index < lines.length; index += 1) {
        const line = lines[index];
        if (line.trim() === '' || isHeadingLine(line)) break;
        paragraphLines.push(collapseWhitespace(stripInlineMarkup(line)));
      }
      const paragraphText = collapseWhitespace(paragraphLines.join(' '));

      const previewParts = [];
      if (headingText !== '') previewParts.push(headingText);
      if (paragraphText !== '') previewParts.push(paragraphText);
      let preview = previewParts.join('\n');
      if (preview.length > PLAN_PREVIEW_MAX_CHARS) {
        preview = `${preview.slice(0, PLAN_PREVIEW_MAX_CHARS).trimEnd()}…`;
      }
      return { preview, chars };
    }

    async function approveReview({ pending, review }) {
      if (pending === null || pending === undefined || typeof pending.answer !== 'function') {
        throw new Error('The plan review is no longer available.');
      }
      const snapshot = typeof pending.snapshot === 'function' ? pending.snapshot() : undefined;
      const channel = snapshot?.channel;
      await pending.answer({ answers: [{ id: review.id, selected: [review.approve.label] }] });
      if (channel === 'rpc' && typeof pending.dismiss === 'function') {
        try {
          await pending.dismiss();
        } catch {
          // The Host projection closed the card while the answer settled.
        }
      }
    }

    /**
     * Dismiss the pending plan review, exactly like the native Discuss action.
     *
     * The review stays pending and reopenable; only the card is hidden.
     */
    async function dismissReview({ pending } = {}) {
      if (pending === null || pending === undefined || typeof pending.dismiss !== 'function') {
        throw new ActionError('dismissFailed', { message: 'The plan review is no longer available.' });
      }
      try {
        await pending.dismiss();
      } catch (error) {
        throw new ActionError('dismissFailed', { message: messageOf(error) });
      }
    }

    /**
     * Run the Host compaction command and normalize its outcome.
     *
     * Never throws: expected failures return `{ ok: false, message, code?, raw? }`
     * so the panel can show a localized warning and keep its buttons usable.
     */
    async function runCompactCommand({ ctx, sessionId, signal } = {}) {
      try {
        const result = await ctx.remote.commands.execute(sessionId, COMPACT_COMMAND, [], signal);
        if (!result?.ok) {
          const failure = result?.error;
          const message = failure !== undefined && failure !== null
            ? `${failure.message} (${failure.code})`
            : 'The /great-plan-compact command failed.';
          const code = typeof failure?.code === 'string' ? failure.code : undefined;
          return code === undefined ? { ok: false, message } : { ok: false, message, code };
        }
        if (result.value === undefined) return { ok: false, message: COMPACT_UNAVAILABLE_MESSAGE };
        const outcome = result.value?.result;
        if (outcome?.kind === 'success') {
          return { ok: true, message: typeof outcome.text === 'string' ? outcome.text : '' };
        }
        const raw = typeof outcome?.text === 'string' ? outcome.text : '';
        return { ok: false, message: raw, raw };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
      }
    }

    /**
     * Localize one compact failure message by exact match. Unknown (dynamic)
     * Host messages fall back to the original English text; never throws.
     */
    function describeCompactFailure(t, message) {
      try {
        if (typeof message !== 'string') return message;
        const key = COMPACT_MESSAGE_KEYS[message];
        if (typeof key !== 'string') return message;
        if (typeof t === 'function') {
          try {
            const localized = t(key);
            if (typeof localized === 'string' && localized !== '') return localized;
          } catch {
            // Fall through to the Host text.
          }
        }
        return message;
      } catch {
        return message;
      }
    }

    function composeFreshTitle(title, suffix) {
      const base = typeof title === 'string' ? title.trim().replace(/\s+/g, ' ') : '';
      if (base === '') return undefined;
      const tail = typeof suffix === 'string' ? suffix : '';
      if (tail !== '' && base.endsWith(tail)) return truncate(base, 80);
      return truncate(`${base}${tail}`, 80);
    }

    function truncate(value, max) {
      if (value.length <= max) return value;
      return `${value.slice(0, max - 1).trimEnd()}…`;
    }

    function selectionPayload(selection) {
      if (selection === null || selection === undefined) return undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      };
    }

    /** Abort the fresh start when the review settled between opening and prompting. */
    async function assertReviewStillPending({ stillPending, readPending }) {
      if (typeof stillPending === 'function') {
        if (!await stillPending()) throw new ActionError('reviewGone');
        return;
      }
      if (typeof readPending === 'function') {
        const pending = await readPending();
        if (pending === null || pending === undefined) throw new ActionError('reviewGone');
      }
    }

    /**
     * Archive a session created by a failed execution; best-effort only.
     *
     * A cleanup failure never replaces the original error: it is logged and
     * attached as `.cleanupError` so the dialog can mention it.
     */
    async function archiveFailedExecution(ctx, sessionId, error) {
      try {
        await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true });
      } catch (cleanupError) {
        const message = messageOf(cleanupError);
        console.warn('great-plan: the unused new session could not be archived:', message);
        try {
          error.cleanupError = message;
        } catch {
          // A thrown primitive cannot carry the cleanup detail.
        }
      }
    }

    /**
     * Create a fresh session in the same workspace, send the composed first
     * message, then stop the old session and open the new one.
     *
     * Ordering is load-bearing: plan-mode instructions are read in parallel
     * with session creation; the still-pending check runs right before the
     * prompt; every failure after creation archives the new session; the old
     * session is cancelled before the new one is opened (the open is
     * synchronous and may throw).
     */
    async function createFreshExecution(args = {}) {
      const {
        ctx,
        sessionId,
        review,
        presetId,
        workspaceId,
        workspaceDirectory,
        cwd,
        selection,
        title,
        titleSuffix,
        signal,
        t,
        readPromptSwitches,
        runtimeFacts,
        instructions,
        switches,
        stillPending,
        readPending,
      } = args;

      const planBody = typeof review?.plan === 'string' ? review.plan.trim() : '';
      if (planBody === '') throw new ActionError('emptyPlan');

      const resolvedSwitches = switches === undefined
        ? normalizePromptSwitches(readPromptSwitches)
        : normalizePromptSwitches(() => switches);
      const reusedInstructions = Array.isArray(instructions) ? normalizeInstructionTexts(instructions) : undefined;
      const instructionPromise = resolvedSwitches.includeOriginalInstructions && reusedInstructions === undefined
        ? readPlanModeInstructions(ctx, sessionId, { signal }).catch(() => ({
          texts: [],
          found: false,
          kind: undefined,
          pagesLoaded: 0,
        }))
        : undefined;

      const location = workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {};
      let newSessionId;
      try {
        newSessionId = await ctx.sessions.create({
          ...location,
          ...presetId === undefined ? {} : { agentPreset: presetId },
        });
      } catch (error) {
        throw new ActionError('createSessionFailed', { message: messageOf(error) });
      }

      try {
        const instructionTexts = resolvedSwitches.includeOriginalInstructions
          ? (reusedInstructions ?? (instructionPromise === undefined ? [] : (await instructionPromise).texts))
          : [];
        const facts = resolvedSwitches.includeMinimalContext && presetId === 'minimal'
          ? (runtimeFacts ?? readRuntimeFacts())
          : undefined;
        const promptText = composeFreshPrompt({
          plan: review?.plan,
          t,
          presetId,
          instructions: instructionTexts,
          workspaceDirectory: workspaceDirectory ?? cwd,
          runtimeFacts: facts,
          switches: resolvedSwitches,
        });

        await ctx.sessions.using(newSessionId, { source: 'greatPlan', signal }, async (reference) => {
          const session = reference.binding.session;
          const renameTask = (async () => {
            const freshTitle = composeFreshTitle(title, titleSuffix);
            if (freshTitle === undefined) return;
            try {
              await session.rename(freshTitle);
            } catch {
              // The title prefix is best-effort; execution must not depend on it.
            }
          })();
          const selectionTask = (async () => {
            const payload = selectionPayload(selection);
            if (payload === undefined) return;
            let selected;
            try {
              selected = await ctx.remote.session.selectModel({ sessionId: newSessionId, ...payload });
            } catch (error) {
              throw new ActionError('modelApplyFailed', { message: messageOf(error) });
            }
            if (!selected?.ok) {
              throw new ActionError('modelApplyFailed', { message: rpcFailureMessage(selected) });
            }
          })();
          await Promise.all([renameTask, selectionTask]);
          await assertReviewStillPending({ stillPending, readPending });
          let prompt;
          try {
            prompt = await session.prompt(
              [{ type: 'text', text: promptText }],
              'queue',
              signal,
            );
          } catch (error) {
            throw new ActionError('startSessionFailed', { message: messageOf(error) });
          }
          if (!prompt?.ok) {
            throw new ActionError('startSessionFailed', { message: rpcFailureMessage(prompt) });
          }
        });
      } catch (error) {
        await archiveFailedExecution(ctx, newSessionId, error);
        throw error;
      }

      let cancelError;
      try {
        const previous = ctx.sessions.binding?.(sessionId);
        if (previous !== undefined && previous !== null) {
          let cancelled;
          try {
            cancelled = await previous.session.cancel();
          } catch (error) {
            cancelError = messageOf(error);
          }
          if (cancelled !== undefined && cancelled !== null && cancelled.ok === false) {
            const detail = cancelled.error;
            cancelError = detail === undefined || detail === null
              ? 'The previous session could not be stopped.'
              : `${detail.message} (${detail.code})`;
          }
        }
      } catch (error) {
        cancelError = messageOf(error);
      }

      try {
        ctx.uiWorkspace.openSession(newSessionId);
      } catch (error) {
        console.warn('great-plan: opening the new session failed:', messageOf(error));
        const wrapped = new ActionError('openSessionFailed', { message: messageOf(error) });
        await archiveFailedExecution(ctx, newSessionId, wrapped);
        throw wrapped;
      }

      return { sessionId: newSessionId, cancelError };
    }

    /** Render one RPC failure detail as `message (code)`. */
    function rpcFailureMessage(result) {
      const detail = result?.error;
      if (detail === undefined || detail === null) return 'unknown error';
      return `${detail.message} (${detail.code})`;
    }

    function createActions(ctx, sessionId, readPromptSwitches) {
      return {
        approveReview,
        composeFreshTitle,
        runCompactCommand: (args) => runCompactCommand({ ctx, sessionId, ...args }),
        createFreshExecution: (args) => createFreshExecution({ ctx, sessionId, ...args, readPromptSwitches }),
        readPlanModeInstructions: (options) => readPlanModeInstructions(ctx, sessionId, options),
        dismissReview: (args) => dismissReview(args),
      };
    }

    return {
      messageOf,
      UNLIMITED_BUDGET_REMINDER,
      PLAN_MODE_INSTRUCTIONS_TAG,
      FRESH_SESSION_CONTEXT_TAG,
      FRESH_PROMPT_WARN_CHARS,
      ACTION_ERROR_CODES,
      ACTION_ERROR_MESSAGES,
      COMPACT_MESSAGE_KEYS,
      ActionError,
      describeActionError,
      describeCompactFailure,
      describeFreshPrompt,
      planPreviewText,
      normalizePromptSwitches,
      textOf,
      findPlanModeStart,
      findTurnStart,
      collectPlanModeInstructions,
      readPlanModeInstructions,
      readSystemName,
      resolveTimeZone,
      formatTimestamp,
      readRuntimeFacts,
      buildMinimalRuntimeContext,
      composeFreshPrompt,
      approveReview,
      dismissReview,
      runCompactCommand,
      createFreshExecution,
      createActions,
      composeFreshTitle,
      buildPlanExecutionPrompt,
    };
  },
});
