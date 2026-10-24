window.__ModuleLoader__.load({
  id: '@local/dsh-great-plan',
  chunk: 'client.actions.js',
  factory() {
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
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

    async function runCompactCommand({ ctx, sessionId, signal }) {
      try {
        const result = await ctx.remote.commands.execute(sessionId, '/great-plan-compact', [], signal);
        if (!result.ok) return { ok: false, message: `${result.error.message} (${result.error.code})` };
        if (result.value === undefined) return { ok: false, message: 'The /great-plan-compact command is not available.' };
        const outcome = result.value.result;
        if (outcome.kind === 'success') return { ok: true, message: outcome.text ?? '' };
        return { ok: false, message: outcome.text };
      } catch (error) {
        return { ok: false, message: messageOf(error) };
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

    function buildPlanExecutionPrompt(plan, t) {
      const body = typeof plan === 'string' ? plan.trim() : '';
      if (body === '') throw new Error('The reviewed plan is empty.');
      const intro = typeof t === 'function'
        ? t('clear.promptIntro')
        : 'The user approved the following plan. Execute it now without re-planning.';
      return `${intro}\n\n<approved-plan>\n${body}\n</approved-plan>`;
    }

    function selectionPayload(selection) {
      if (selection === null || selection === undefined) return undefined;
      return {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      };
    }

    async function createFreshExecution({ ctx, sessionId, review, presetId, workspaceId, cwd, selection, title, titleSuffix, signal, t }) {
      const location = workspaceId !== undefined ? { workspaceId } : cwd !== undefined ? { cwd } : {};
      let newSessionId;
      try {
        newSessionId = await ctx.sessions.create({
          ...location,
          ...presetId === undefined ? {} : { agentPreset: presetId },
        });
      } catch (error) {
        throw new Error(`Creating the new session failed: ${messageOf(error)}`);
      }

      try {
        await ctx.sessions.using(newSessionId, { source: 'greatPlan', signal }, async (reference) => {
          const session = reference.binding.session;
          const freshTitle = composeFreshTitle(title, titleSuffix);
          if (freshTitle !== undefined) {
            try {
              await session.rename(freshTitle);
            } catch {
              // The title prefix is best-effort; execution must not depend on it.
            }
          }
          const payload = selectionPayload(selection);
          if (payload !== undefined) {
            const selected = await ctx.remote.session.selectModel({ sessionId: newSessionId, ...payload });
            if (!selected.ok) throw new Error(`Applying the model selection failed: ${selected.error.message} (${selected.error.code})`);
          }
          const prompt = await session.prompt(
            [{ type: 'text', text: buildPlanExecutionPrompt(review.plan, t) }],
            'queue',
            signal,
          );
          if (!prompt.ok) throw new Error(`Starting the new session failed: ${prompt.error.message} (${prompt.error.code})`);
        });
      } catch (error) {
        try {
          await ctx.uiWorkspace.archiveSession(newSessionId, { stopActivity: true });
        } catch {
          // Best-effort cleanup of the unused session.
        }
        throw error;
      }

      try {
        ctx.uiWorkspace.openSession(newSessionId);
      } catch (error) {
        throw new Error(`The new session started but could not be opened: ${messageOf(error)}`);
      }

      let cancelError;
      const previous = ctx.sessions.binding(sessionId);
      if (previous !== undefined) {
        try {
          const cancelled = await previous.session.cancel();
          if (!cancelled.ok) cancelError = `${cancelled.error.message} (${cancelled.error.code})`;
        } catch (error) {
          cancelError = messageOf(error);
        }
      }
      return { sessionId: newSessionId, cancelError };
    }

    function createActions(ctx, sessionId) {
      return {
        approveReview,
        composeFreshTitle,
        runCompactCommand: (args) => runCompactCommand({ ctx, sessionId, ...args }),
        createFreshExecution: (args) => createFreshExecution({ ctx, sessionId, ...args }),
      };
    }

    return {
      messageOf,
      approveReview,
      runCompactCommand,
      createFreshExecution,
      createActions,
      composeFreshTitle,
      buildPlanExecutionPrompt,
    };
  },
});
