window.__ModuleLoader__.load({
  id: '@onefl666/dsh-great-plan',
  chunk: 'client.panel.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ui = require('@onefl666/dsh-great-plan/client.ui.js');
    const model = require('@onefl666/dsh-great-plan/client.model.js');
    const preset = require('@onefl666/dsh-great-plan/client.preset.js');
    const actionHelpers = require('@onefl666/dsh-great-plan/client.actions.js');

    const { useEffect, useMemo, useRef, useState } = React;

    /** Instructions state before the clear view reads the old session. */
    function emptyInstructions() {
      return { status: 'idle', texts: [], count: 0, chars: 0 };
    }

    /** The fresh-message preview; the shared assembler throws ActionError('emptyPlan') for an empty plan. */
    function freshPreviewOf(input) {
      try {
        return actionHelpers.describeFreshPrompt(input);
      } catch {
        return {
          text: '',
          blocks: [],
          instructionCount: 0,
          instructionChars: 0,
          totalChars: 0,
          approxTokens: 0,
          oversized: false,
        };
      }
    }

    /**
     * Approved-plan section shared by the root and clear views.
     *
     * The plan heading is a real h3 and the expanded pre becomes a labelled
     * region; the toggle only exists when the review carries plan text.
     */
    function planSectionOf({ review, t, expanded, onToggle }) {
      const info = actionHelpers.planPreviewText(review?.plan);
      const body = typeof review?.plan === 'string' ? review.plan : '';
      const question = typeof review?.question === 'string' ? review.question.trim() : '';
      const expandable = body.trim() !== '';
      return h('div', {
        className: 'gp-plan',
        role: expanded && expandable ? 'region' : undefined,
        'aria-label': expanded && expandable ? t('preview.plan') : undefined,
      },
      h('h3', { className: 'gp-plan-heading' }, t('preview.plan')),
      question === '' ? null : h('p', { className: 'gp-plan-question' }, question),
      info.preview === '' ? null : h('p', { className: 'gp-plan-preview' }, info.preview),
      expandable ? h(ui.Button, {
        variant: 'ghost',
        className: 'gp-plan-toggle',
        'aria-expanded': expanded,
        onClick: onToggle,
      }, expanded ? t('preview.hidePlan') : t('preview.viewPlan')) : null,
      expanded && expandable
        ? h('pre', { className: 'gp-plan-body' }, body)
        : null,
      );
    }

    function ExecutionTrigger(props) {
      const {
        review,
        requestKey,
        directory,
        actions,
        presetStore,
        sessionId,
        useSessionStatus,
        useSessions,
        useWorkspaces,
        t,
        modelAvailable,
        readPromptSwitches,
      } = props;
      const pending = useSessionStatus((snapshot) => snapshot.get(sessionId)?.pendingInteraction);
      const row = useSessions((snapshot) => snapshot.byId[sessionId]);
      const workspaces = useWorkspaces((snapshot) => snapshot);
      const [open, setOpen] = useState(false);
      const triggerRef = useRef(null);
      const workspace = useMemo(
        () => workspaces.items?.find((item) => item.sessionIds?.includes(sessionId)),
        [workspaces, sessionId],
      );
      const workspaceId = workspace?.workspaceId;
      const workspaceDirectory = workspace?.path ?? row?.cwd;

      useEffect(() => {
        setOpen(false);
      }, [requestKey]);

      if (pending === undefined || pending.kind !== 'plan-review') return null;

      return h(React.Fragment, null,
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'gp-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': t('trigger.aria'),
          title: t('trigger.aria'),
          onClick: () => setOpen(true),
        },
        h(ui.IconSliders),
        h('span', { className: 'gp-trigger-label' }, t('trigger.label')),
        h(ui.IconChevronDown, { className: 'gp-trigger-chevron' }),
        ),
        open
          ? h(ExecutionDialog, {
            open,
            onClose: () => setOpen(false),
            triggerRef,
            pending,
            review,
            directory,
            actions,
            presetStore,
            sessionId,
            workspaceId,
            workspaceDirectory,
            cwd: row?.cwd,
            title: row?.title,
            currentPreset: row?.projectionValues?.agentPreset ?? undefined,
            modelAvailable,
            readPromptSwitches,
            t,
          })
          : null,
      );
    }

    function ExecutionDialog(props) {
      const {
        open,
        onClose,
        triggerRef,
        pending,
        review,
        directory,
        actions,
        presetStore,
        sessionId,
        workspaceId,
        workspaceDirectory,
        cwd,
        title,
        currentPreset,
        modelAvailable,
        readPromptSwitches,
        t,
      } = props;
      const directoryState = model.useDirectoryState(directory);
      const presetState = ui.useStore(presetStore.store);
      const [view, setView] = useState('root');
      const [busy, setBusy] = useState(null);
      const [error, setError] = useState(null);
      const [cleanupWarning, setCleanupWarning] = useState(null);
      const [compactFailure, setCompactFailure] = useState(null);
      const [statusLine, setStatusLine] = useState(null);
      const [presetChoice, setPresetChoice] = useState(null);
      const [runSwitches, setRunSwitches] = useState(null);
      const [previewFacts, setPreviewFacts] = useState(null);
      const [instructionsState, setInstructionsState] = useState(emptyInstructions);
      const [planExpanded, setPlanExpanded] = useState(false);
      const aliveRef = useRef(true);
      const abortRef = useRef(null);
      const instructionsAbortRef = useRef(null);
      const titleRef = useRef(null);
      const previousViewRef = useRef(view);
      const pendingRef = useRef(pending);
      pendingRef.current = pending;

      useEffect(() => () => {
        aliveRef.current = false;
        abortRef.current?.abort();
        instructionsAbortRef.current?.abort();
      }, []);

      useEffect(() => {
        directory.load().catch(() => {});
      }, [open, directory]);

      useEffect(() => {
        if (!open || view !== 'clear') return;
        presetStore.load().catch(() => {});
      }, [open, view, presetStore]);

      useEffect(() => {
        if (previousViewRef.current === view) return;
        previousViewRef.current = view;
        const node = titleRef.current;
        if (node !== null && node !== undefined && typeof node.focus === 'function') node.focus();
      }, [view]);

      const options = presetState.options ?? [];
      const defaultPresetId = preset.defaultPresetId(presetState);
      const currentPresetAvailable = currentPreset !== undefined && options.some((option) => option.id === currentPreset);
      const effectivePresetId = presetChoice ?? (currentPresetAvailable ? currentPreset : defaultPresetId);
      const selectedPreset = options.find((option) => option.id === effectivePresetId);
      const presetLabel = selectedPreset === undefined
        ? (effectivePresetId ?? t('preset.default'))
        : preset.presetDisplay(selectedPreset, t);
      const previewTitle = actions.composeFreshTitle(title, t('clear.titleSuffix'));
      const modelSelecting = directoryState.status === 'selecting';
      const controlBusy = busy !== null || modelSelecting;
      const blocked = busy === 'model'
        || busy === 'effort'
        || busy === 'execute'
        || busy === 'clear'
        || modelSelecting;
      const canRevise = typeof pending?.dismiss === 'function' && !blocked;
      const switches = runSwitches ?? actionHelpers.normalizePromptSwitches(readPromptSwitches);

      const start = (kind) => {
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(kind);
        setError(null);
        setCleanupWarning(null);
        setStatusLine(null);
        return controller;
      };

      const finish = () => {
        if (aliveRef.current) setBusy(null);
      };

      const close = () => {
        if (blocked) return;
        abortRef.current?.abort();
        instructionsAbortRef.current?.abort();
        onClose();
      };

      const startInstructionsRead = () => {
        if (typeof actions.readPlanModeInstructions !== 'function') {
          setInstructionsState({ status: 'unavailable', texts: [], count: 0, chars: 0 });
          return;
        }
        instructionsAbortRef.current?.abort();
        const controller = new AbortController();
        instructionsAbortRef.current = controller;
        setInstructionsState({ status: 'loading', texts: [], count: 0, chars: 0 });
        let read;
        try {
          read = actions.readPlanModeInstructions({ signal: controller.signal });
        } catch {
          read = undefined;
        }
        Promise.resolve(read).then(
          (result) => {
            if (!aliveRef.current || controller.signal.aborted) return;
            const texts = Array.isArray(result?.texts)
              ? result.texts.filter((text) => typeof text === 'string' && text.trim() !== '')
              : [];
            const chars = texts.reduce((sum, text) => sum + text.length, 0);
            setInstructionsState({
              status: texts.length > 0 ? 'ready' : 'unavailable',
              texts,
              count: texts.length,
              chars,
            });
          },
          () => {
            if (!aliveRef.current || controller.signal.aborted) return;
            setInstructionsState({ status: 'unavailable', texts: [], count: 0, chars: 0 });
          },
        );
      };

      const enterClear = () => {
        if (blocked || controlBusy) return;
        setError(null);
        setStatusLine(null);
        setCompactFailure(null);
        setCleanupWarning(null);
        setPreviewFacts(actionHelpers.readRuntimeFacts());
        const initial = actionHelpers.normalizePromptSwitches(readPromptSwitches);
        setRunSwitches(initial);
        setInstructionsState(emptyInstructions());
        if (initial.includeOriginalInstructions) startInstructionsRead();
        setView('clear');
      };

      const leaveClear = () => {
        instructionsAbortRef.current?.abort();
        instructionsAbortRef.current = null;
        setInstructionsState(emptyInstructions());
      };

      const toggleSwitch = (name) => {
        const current = runSwitches ?? actionHelpers.normalizePromptSwitches(readPromptSwitches);
        const next = { ...current, [name]: !current[name] };
        setRunSwitches(next);
        if (name === 'includeOriginalInstructions'
          && next.includeOriginalInstructions
          && instructionsState.status !== 'ready'
          && instructionsState.status !== 'loading') {
          startInstructionsRead();
        }
      };

      const applySelection = async (kind, payload) => {
        if (busy !== null) return;
        if (kind === 'effort' && (directoryState.current === null || directoryState.current === undefined)) return;
        setBusy(kind);
        setError(null);
        try {
          const result = await directory.select(payload);
          if (!aliveRef.current) return;
          if (!result.ok) {
            setError(t('error.selectModelFailed', { message: actionHelpers.formatRpcFailure(result) }));
            return;
          }
          setView('root');
        } catch (caught) {
          if (aliveRef.current) setError(t('error.selectModelFailed', { message: ui.messageOf(caught) }));
        } finally {
          finish();
        }
      };

      const approvePending = async () => {
        if (busy !== null) return;
        if (pending === undefined) {
          setError(t('error.reviewGone'));
          return;
        }
        const controller = start('execute');
        try {
          await actions.approveReview({ pending, review });
          if (aliveRef.current) onClose();
        } catch (caught) {
          if (aliveRef.current && !controller.signal.aborted) {
            setError(actionHelpers.describeActionError(t, caught) ?? t('error.approveFailed', { message: ui.messageOf(caught) }));
          }
        } finally {
          finish();
        }
      };

      const compact = async () => {
        if (busy !== null) return;
        if (pending === undefined) {
          setError(t('error.reviewGone'));
          return;
        }
        const controller = start('compact');
        try {
          let result;
          try {
            result = await actions.runCompactCommand({ signal: controller.signal });
          } catch (caught) {
            result = { ok: false, message: ui.messageOf(caught) };
          }
          if (!aliveRef.current || controller.signal.aborted) return;
          if (!result.ok) {
            setCompactFailure({ message: result.message, code: result.code, raw: result.raw });
            return;
          }
          setCompactFailure(null);
          setStatusLine(t('compact.success'));
          try {
            await actions.approveReview({ pending, review });
            if (aliveRef.current) onClose();
          } catch (caught) {
            if (aliveRef.current && !controller.signal.aborted) {
              setStatusLine(null);
              setError(actionHelpers.describeActionError(t, caught) ?? t('error.approveFailed', { message: ui.messageOf(caught) }));
            }
          }
        } finally {
          finish();
        }
      };

      const cancelCompactFailure = () => {
        setCompactFailure(null);
        setStatusLine(null);
        close();
      };

      const revise = async () => {
        if (busy !== null) return;
        setBusy('dismiss');
        setError(null);
        setCleanupWarning(null);
        setStatusLine(null);
        setCompactFailure(null);
        try {
          await actions.dismissReview({ pending });
          if (aliveRef.current) onClose();
        } catch (caught) {
          if (aliveRef.current) setError(actionHelpers.describeActionError(t, caught) ?? t('error.dismissFailed', { message: ui.messageOf(caught) }));
        } finally {
          finish();
        }
      };

      const clearExecute = async () => {
        if (busy !== null) return;
        if (pending === undefined) {
          setError(t('error.reviewGone'));
          return;
        }
        const activeSwitches = runSwitches ?? actionHelpers.normalizePromptSwitches(readPromptSwitches);
        if (activeSwitches.includeOriginalInstructions && instructionsState.status === 'loading') return;
        const controller = start('clear');
        try {
          const result = await actions.createFreshExecution({
            review,
            presetId: effectivePresetId,
            workspaceId,
            workspaceDirectory,
            cwd,
            selection: model.toModelSelection(directoryState.current),
            title,
            titleSuffix: t('clear.titleSuffix'),
            signal: controller.signal,
            instructions: activeSwitches.includeOriginalInstructions ? instructionsState.texts : undefined,
            switches: activeSwitches,
            stillPending: () => pendingRef.current !== undefined,
          });
          if (!aliveRef.current) return;
          if (result?.cancelError !== undefined) {
            console.warn('great-plan: the previous session was not stopped:', result.cancelError);
          }
          onClose();
        } catch (caught) {
          if (aliveRef.current && !controller.signal.aborted) {
            setError(actionHelpers.describeActionError(t, caught) ?? t('error.freshFailed', { message: ui.messageOf(caught) }));
            const cleanup = caught?.cleanupError;
            if (typeof cleanup === 'string' && cleanup !== '') {
              setCleanupWarning(t('error.cleanupFailed', { message: cleanup }));
            }
          }
        } finally {
          finish();
        }
      };

      const back = () => {
        if (blocked) return;
        setError(null);
        setStatusLine(null);
        setCompactFailure(null);
        setCleanupWarning(null);
        if (view === 'preset') {
          setView('clear');
          return;
        }
        if (view === 'clear') leaveClear();
        setView('root');
      };

      const titles = {
        root: t('panel.title'),
        model: t('panel.model'),
        effort: t('panel.effort'),
        clear: t('clear.title'),
        preset: t('preset.title'),
      };

      const renderHeader = () => {
        let subtitle;
        if (view === 'model' || view === 'effort') subtitle = model.summaryOf(directoryState, t);
        else if (view === 'root') subtitle = t('panel.subtitle');
        return h('div', { className: 'gp-dialog-header' },
          view === 'root' ? null : h(ui.IconButton, {
            label: t('panel.back'),
            onClick: back,
            disabled: blocked,
          }, h(ui.IconChevronLeft)),
          h('div', { className: 'gp-dialog-title-wrap' },
            h('h2', {
              ref: titleRef,
              className: 'gp-dialog-title',
              id: 'gp-great-plan-title',
              tabIndex: -1,
              title: titles[view],
            }, titles[view]),
            subtitle === undefined ? null : h('div', { className: 'gp-dialog-subtitle' }, subtitle),
          ),
          h(ui.IconButton, {
            label: t('panel.close'),
            onClick: close,
            disabled: blocked,
            autoFocus: true,
          }, h(ui.IconClose)),
        );
      };

      const planSection = planSectionOf({
        review,
        t,
        expanded: planExpanded,
        onToggle: () => setPlanExpanded((value) => !value),
      });

      const renderCompactFailure = () => compactFailure === null
        ? null
        : h('div', { className: 'gp-failure' },
          h(ui.WarningBox, null, t('compact.failed', { message: actionHelpers.describeCompactFailure(t, compactFailure.message) })),
          h(ui.Note, null, t('compact.failedHint')),
          h('div', { className: 'gp-failure-actions' },
            h(ui.Button, {
              variant: 'outline',
              disabled: controlBusy,
              onClick: compact,
            }, busy === 'compact' ? h(ui.Loading, null, t('compact.retrying')) : t('compact.retry')),
            h(ui.Button, {
              variant: 'primary',
              disabled: controlBusy,
              onClick: approvePending,
            }, t('compact.proceed')),
            h(ui.Button, {
              variant: 'ghost',
              disabled: controlBusy,
              onClick: cancelCompactFailure,
            }, t('compact.cancel')),
          ),
        );

      const renderModelView = () => h('div', { className: 'gp-dialog-body' },
        error === null ? null : h(ui.ErrorText, null, error),
        h(model.ModelListView, {
          state: directoryState,
          t,
          disabled: controlBusy,
          onPick: (group, item) => applySelection('model', { provider: group.id, model: item.id }),
          onRetry: () => directory.load().catch(() => {}),
        }),
      );

      const renderEffortView = () => h('div', { className: 'gp-dialog-body' },
        error === null ? null : h(ui.ErrorText, null, error),
        h(model.EffortListView, {
          state: directoryState,
          t,
          disabled: controlBusy,
          onPick: (effort) => {
            if (directoryState.current === null || directoryState.current === undefined) return;
            applySelection('effort', {
              provider: directoryState.current.provider,
              model: directoryState.current.model,
              ...effort === undefined ? {} : { reasoningEffort: effort },
            });
          },
        }),
      );

      const renderPresetView = () => h('div', { className: 'gp-dialog-body' },
        h(preset.PresetOptions, {
          state: presetState,
          t,
          selectedId: effectivePresetId,
          onPick: (id) => {
            setPresetChoice(id);
            setView('clear');
          },
          onRetry: () => presetStore.load(true).catch(() => {}),
        }),
      );

      const renderClearView = () => {
        const preview = freshPreviewOf({
          plan: review?.plan,
          presetId: effectivePresetId,
          instructions: instructionsState.texts,
          workspaceDirectory,
          runtimeFacts: previewFacts ?? undefined,
          switches,
        });
        const instructionsOn = switches.includeOriginalInstructions === true;
        const instructionsLoading = instructionsOn && instructionsState.status === 'loading';
        const directoryLoading = directoryState.status === 'loading' || directoryState.status === 'idle';
        const directoryError = directoryState.status === 'error';
        const minimalDisabled = effectivePresetId !== 'minimal';
        const runtimeIncluded = switches.includeMinimalContext === true && effectivePresetId === 'minimal';
        const confirmDisabled = controlBusy || directoryLoading || instructionsLoading;
        return h('div', { className: 'gp-dialog-body' },
          planSection,
          h(ui.WarningBox, null, t('clear.warning')),
          h(ui.SelectRow, {
            label: t('clear.preset'),
            value: presetLabel,
            disabled: controlBusy,
            onClick: () => setView('preset'),
          }),
          h(ui.StaticRow, { label: t('clear.titleLabel'), value: previewTitle ?? t('clear.autoTitle') }),
          h(ui.StaticRow, { label: t('clear.model'), value: model.summaryOf(directoryState, t) }),
          h(ui.Note, null, t('clear.modelHint')),
          h('div', { className: 'gp-plan' },
            h('h3', { className: 'gp-plan-heading' }, t('preview.title')),
            h('div', { className: 'gp-note' }, t('preview.blocks')),
            (preview.blocks ?? []).map((block, index) => h('div', {
              key: block?.id ?? `block-${index}`,
              className: 'gp-static-row',
            },
            h('span', { className: 'gp-static-label' }, t(block?.titleKey ?? 'preview.title')),
            h('span', { className: 'gp-static-value' }, block?.included === false
              ? t('preview.excluded')
              : `${t('preview.included')} · ${typeof block?.chars === 'number' ? block.chars : 0}`),
            )),
            instructionsOn
              ? (
                instructionsLoading
                  ? h(ui.Note, null, h(ui.Loading, null, t('preview.loadingInstructions')))
                  : instructionsState.status === 'ready'
                    ? h(ui.Note, null, t('preview.instructionCount', {
                      count: instructionsState.count,
                      chars: instructionsState.chars,
                    }))
                    : h(ui.Note, null, t('preview.instructionsUnavailable'))
              )
              : h(ui.Note, null, t('preview.noInstructions')),
            h(ui.Note, null, t('preview.total', { chars: preview.totalChars ?? 0 })),
            h(ui.Note, null, t('preview.approxTokens', { tokens: preview.approxTokens ?? 0 })),
            preview.oversized === true
              ? h(ui.WarningText, null, t('preview.oversized', { chars: preview.totalChars ?? 0 }))
              : null,
            runtimeIncluded ? h(ui.Note, null, t('preview.runtimeHint')) : null,
          ),
          h('div', { className: 'gp-checks', role: 'group', 'aria-label': t('preview.switches') },
            h('div', { className: 'gp-check-heading' }, t('preview.switches')),
            h(ui.Checkbox, {
              label: t('preview.switchBudget'),
              checked: switches.unlimitedBudget !== false,
              disabled: controlBusy,
              onChange: () => toggleSwitch('unlimitedBudget'),
            }),
            h(ui.Checkbox, {
              label: t('preview.switchInstructions'),
              checked: instructionsOn,
              disabled: controlBusy,
              onChange: () => toggleSwitch('includeOriginalInstructions'),
            }),
            h(ui.Checkbox, {
              label: t('preview.switchMinimal'),
              checked: switches.includeMinimalContext !== false,
              disabled: controlBusy || minimalDisabled,
              hint: minimalDisabled ? t('preview.minimalSwitchHint') : undefined,
              onChange: () => toggleSwitch('includeMinimalContext'),
            }),
          ),
          directoryLoading ? h(ui.Note, null, t('panel.modelDirectoryLoading')) : null,
          directoryError ? h(ui.Note, null, t('panel.modelDirectoryError')) : null,
          cleanupWarning === null ? null : h(ui.WarningText, null, cleanupWarning),
          error === null ? null : h(ui.ErrorText, null, error),
          h('div', { className: 'gp-clear-actions' },
            h(ui.Button, {
              variant: 'primary',
              full: true,
              disabled: confirmDisabled,
              onClick: clearExecute,
            }, busy === 'clear' ? h(ui.Loading, null, t('clear.busy')) : t('clear.confirm')),
          ),
          h(ui.Note, { className: 'gp-footer-note' }, t('clear.kept')),
        );
      };

      const renderRootView = () => h('div', { className: 'gp-dialog-body' },
        planSection,
        h(model.ModelRows, {
          state: directoryState,
          t,
          disabled: !modelAvailable || controlBusy,
          onOpenModel: () => setView('model'),
          onOpenEffort: () => setView('effort'),
          onRetry: () => directory.load().catch(() => {}),
        }),
        !modelAvailable ? h(ui.Note, null, t('panel.subagentUnavailable')) : null,
        renderCompactFailure(),
        statusLine === null ? null : h('div', { className: 'gp-status', role: 'status' }, statusLine),
        error === null ? null : h(ui.ErrorText, null, error),
        compactFailure === null
          ? h('div', null,
            h('div', { className: 'gp-separator' }),
            h('div', { className: 'gp-actions' },
              h(ui.ActionRow, {
                primary: true,
                icon: h(ui.IconPlay),
                title: t('panel.actions.execute.title'),
                description: t('panel.actions.execute.description'),
                disabled: controlBusy,
                onClick: approvePending,
              }),
              h(ui.ActionRow, {
                icon: h(ui.IconCompress),
                title: t('panel.actions.compact.title'),
                description: t('panel.actions.compact.description'),
                disabled: controlBusy,
                onClick: compact,
              }),
              h(ui.ActionRow, {
                icon: h(ui.IconNewSession),
                title: t('panel.actions.clear.title'),
                description: t('panel.actions.clear.description'),
                disabled: controlBusy || !modelAvailable,
                onClick: enterClear,
              }),
            ),
          )
          : null,
        canRevise
          ? h('div', { className: 'gp-actions' },
            h(ui.Button, {
              variant: 'ghost',
              full: true,
              disabled: controlBusy,
              onClick: revise,
            }, busy === 'dismiss' ? h(ui.Loading, null, t('panel.loading')) : t('panel.revise')),
          )
          : null,
        h(ui.Note, { className: 'gp-footer-note' }, t('panel.applyNote')),
      );

      const views = {
        model: renderModelView,
        effort: renderEffortView,
        preset: renderPresetView,
        clear: renderClearView,
        root: renderRootView,
      };
      const body = views[view]();

      return h(ui.Dialog, {
        open,
        onRequestClose: close,
        blocked,
        busy: busy !== null,
        anchorRef: triggerRef,
        labelledBy: 'gp-great-plan-title',
      }, renderHeader(), body);
    }

    return {
      ExecutionTrigger,
      ExecutionDialog,
    };
  },
});
