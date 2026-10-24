window.__ModuleLoader__.load({
  id: '@local/dsh-great-plan',
  chunk: 'client.panel.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ui = require('@local/dsh-great-plan/client.ui.js');
    const model = require('@local/dsh-great-plan/client.model.js');
    const preset = require('@local/dsh-great-plan/client.preset.js');

    const { useEffect, useMemo, useRef, useState } = React;

    function delay(ms, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        const onAbort = () => {
          clearTimeout(timer);
          resolve();
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
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
      } = props;
      const pending = useSessionStatus((snapshot) => snapshot.get(sessionId)?.pendingInteraction);
      const row = useSessions((snapshot) => snapshot.byId[sessionId]);
      const workspaces = useWorkspaces((snapshot) => snapshot);
      const [open, setOpen] = useState(false);
      const triggerRef = useRef(null);
      const workspaceId = useMemo(
        () => workspaces.items?.find((workspace) => workspace.sessionIds?.includes(sessionId))?.workspaceId,
        [workspaces, sessionId],
      );

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
        h(ui.IconSliders, { className: 'gp-trigger-icon' }),
        h('span', { className: 'gp-trigger-label' }, t('trigger.label')),
        h(ui.IconChevronDown, { className: 'gp-trigger-chevron' }),
        ),
        h(ExecutionDialog, {
          open,
          onClose: () => setOpen(false),
          triggerRef,
          pending,
          review,
          requestKey,
          directory,
          actions,
          presetStore,
          sessionId,
          workspaceId,
          cwd: row?.cwd,
          title: row?.title,
          currentPreset: row?.projectionValues?.agentPreset ?? undefined,
          modelAvailable,
          t,
        }),
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
        cwd,
        title,
        currentPreset,
        modelAvailable,
        t,
      } = props;
      const directoryState = model.useDirectoryState(directory);
      const presetState = preset.usePresetState(presetStore.store);
      const [view, setView] = useState('root');
      const [busy, setBusy] = useState(null);
      const [error, setError] = useState(null);
      const [warning, setWarning] = useState(null);
      const [presetChoice, setPresetChoice] = useState(null);
      const aliveRef = useRef(true);
      const abortRef = useRef(null);

      useEffect(() => () => {
        aliveRef.current = false;
        abortRef.current?.abort();
      }, []);

      useEffect(() => {
        if (!open) {
          setView('root');
          setBusy(null);
          setError(null);
          setWarning(null);
          setPresetChoice(null);
          abortRef.current?.abort();
          return;
        }
        directory.load().catch(() => {});
      }, [open, directory]);

      useEffect(() => {
        if (!open || view !== 'clear') return;
        presetStore.load(true).catch(() => {});
      }, [open, view, presetStore]);

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

      const start = (kind) => {
        const controller = new AbortController();
        abortRef.current = controller;
        setBusy(kind);
        setError(null);
        setWarning(null);
        return controller;
      };

      const finish = () => {
        if (aliveRef.current) setBusy(null);
      };

      const close = () => {
        if (blocked) return;
        abortRef.current?.abort();
        onClose();
      };

      const selectModel = async (group, item) => {
        if (busy !== null) return;
        setBusy('model');
        setError(null);
        try {
          const result = await directory.select({ provider: group.id, model: item.id });
          if (!aliveRef.current) return;
          if (!result.ok) {
            setError(t('error.selectModelFailed', { message: `${result.error.message} (${result.error.code})` }));
            return;
          }
          setView('root');
        } catch (caught) {
          if (aliveRef.current) setError(t('error.selectModelFailed', { message: ui.messageOf(caught) }));
        } finally {
          finish();
        }
      };

      const selectEffort = async (effort) => {
        if (busy !== null || directoryState.current === null || directoryState.current === undefined) return;
        setBusy('effort');
        setError(null);
        try {
          const result = await directory.select({
            provider: directoryState.current.provider,
            model: directoryState.current.model,
            ...effort === undefined ? {} : { reasoningEffort: effort },
          });
          if (!aliveRef.current) return;
          if (!result.ok) {
            setError(t('error.selectModelFailed', { message: `${result.error.message} (${result.error.code})` }));
            return;
          }
          setView('root');
        } catch (caught) {
          if (aliveRef.current) setError(t('error.selectModelFailed', { message: ui.messageOf(caught) }));
        } finally {
          finish();
        }
      };

      const execute = async () => {
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
            setError(t('error.approveFailed', { message: ui.messageOf(caught) }));
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
            setWarning(t('compact.failed', { message: result.message }));
            await delay(800, controller.signal);
            if (!aliveRef.current || controller.signal.aborted) return;
          }
          try {
            await actions.approveReview({ pending, review });
            if (aliveRef.current) onClose();
          } catch (caught) {
            if (aliveRef.current && !controller.signal.aborted) {
              setError(t('error.approveFailed', { message: ui.messageOf(caught) }));
            }
          }
        } finally {
          finish();
        }
      };

      const clearExecute = async () => {
        if (busy !== null) return;
        const controller = start('clear');
        try {
          const selection = model.toModelSelection(directoryState.current);
          const result = await actions.createFreshExecution({
            review,
            presetId: effectivePresetId,
            workspaceId,
            cwd,
            selection,
            title,
            titleSuffix: t('clear.titleSuffix'),
            signal: controller.signal,
            t,
          });
          if (!aliveRef.current) return;
          if (result.cancelError !== undefined) {
            console.warn('great-plan: the previous session was not stopped:', result.cancelError);
          }
          onClose();
        } catch (caught) {
          if (aliveRef.current && !controller.signal.aborted) {
            setError(t('error.freshFailed', { message: ui.messageOf(caught) }));
          }
        } finally {
          finish();
        }
      };

      const back = () => {
        if (blocked) return;
        setError(null);
        setWarning(null);
        setView(view === 'preset' ? 'clear' : 'root');
      };

      const titles = {
        root: t('panel.title'),
        model: t('panel.model'),
        effort: t('panel.effort'),
        clear: t('clear.title'),
        preset: t('preset.title'),
      };

      let subtitle;
      if (view === 'model' || view === 'effort') subtitle = model.summaryOf(directoryState, t);
      else if (view === 'root') subtitle = t('panel.subtitle');

      const header = h('div', { className: 'gp-dialog-header' },
        view === 'root' ? null : h(ui.IconButton, {
          label: t('panel.back'),
          onClick: back,
          disabled: blocked,
        }, h(ui.IconChevronLeft)),
        h('div', { className: 'gp-dialog-title-wrap' },
          h('div', { className: 'gp-dialog-title', id: 'gp-great-plan-title' }, titles[view]),
          subtitle === undefined ? null : h('div', { className: 'gp-dialog-subtitle' }, subtitle),
        ),
        h(ui.IconButton, {
          label: t('panel.close'),
          onClick: close,
          disabled: blocked,
          autoFocus: true,
        }, h(ui.IconClose)),
      );

      let body;
      if (view === 'model') {
        body = h('div', { className: 'gp-dialog-body' },
          error === null ? null : h(ui.ErrorText, null, error),
          h(model.ModelListView, {
            state: directoryState,
            t,
            disabled: controlBusy,
            onPick: selectModel,
            onRetry: () => directory.load().catch(() => {}),
          }),
        );
      } else if (view === 'effort') {
        body = h('div', { className: 'gp-dialog-body' },
          error === null ? null : h(ui.ErrorText, null, error),
          h(model.EffortListView, {
            state: directoryState,
            t,
            disabled: controlBusy,
            onPick: selectEffort,
          }),
        );
      } else if (view === 'preset') {
        body = h('div', { className: 'gp-dialog-body' },
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
      } else if (view === 'clear') {
        body = h('div', { className: 'gp-dialog-body' },
          h(ui.WarningBox, null, t('clear.warning')),
          h(ui.SelectRow, {
            label: t('clear.preset'),
            value: presetLabel,
            disabled: controlBusy,
            onClick: () => setView('preset'),
          }),
          h(ui.StaticRow, { label: t('clear.titleLabel'), value: previewTitle ?? t('clear.autoTitle') }),
          h(ui.StaticRow, { label: t('clear.model'), value: model.summaryOf(directoryState, t) }),
          error === null ? null : h(ui.ErrorText, null, error),
          h('div', { className: 'gp-clear-actions' },
            h(ui.Button, {
              variant: 'primary',
              full: true,
              disabled: controlBusy,
              onClick: clearExecute,
            }, busy === 'clear' ? h(ui.Loading, null, t('clear.busy')) : t('clear.confirm')),
          ),
          h(ui.Note, { className: 'gp-footer-note' }, t('clear.kept')),
        );
      } else {
        body = h('div', { className: 'gp-dialog-body' },
          h(model.ModelRows, {
            state: directoryState,
            t,
            disabled: !modelAvailable || controlBusy,
            onOpenModel: () => setView('model'),
            onOpenEffort: () => setView('effort'),
            onRetry: () => directory.load().catch(() => {}),
          }),
          !modelAvailable ? h(ui.Note, null, t('panel.subagentUnavailable')) : null,
          warning === null ? null : h(ui.WarningText, null, warning),
          error === null ? null : h(ui.ErrorText, null, error),
          h('div', { className: 'gp-separator' }),
          h('div', { className: 'gp-actions' },
            h(ui.ActionRow, {
              primary: true,
              icon: h(ui.IconPlay),
              title: t('panel.actions.execute.title'),
              description: t('panel.actions.execute.description'),
              disabled: controlBusy,
              onClick: execute,
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
              onClick: () => {
                setError(null);
                setWarning(null);
                setView('clear');
              },
            }),
          ),
          h(ui.Note, { className: 'gp-footer-note' }, t('panel.applyNote')),
        );
      }

      return h(ui.Dialog, {
        open,
        onRequestClose: close,
        blocked,
        anchorRef: triggerRef,
        labelledBy: 'gp-great-plan-title',
      }, header, body);
    }

    return {
      ExecutionTrigger,
      ExecutionDialog,
    };
  },
});
