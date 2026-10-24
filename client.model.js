window.__ModuleLoader__.load({
  id: '@local/dsh-great-plan',
  chunk: 'client.model.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ui = require('@local/dsh-great-plan/client.ui.js');

    function useDirectoryState(directory) {
      return React.useSyncExternalStore(
        (listener) => directory.store.subscribe(listener),
        () => directory.store.getSnapshot(),
        () => directory.store.getSnapshot(),
      );
    }

    function currentModelOf(state) {
      const current = state.current;
      if (current === null || current === undefined) return undefined;
      for (const group of state.groups ?? []) {
        if (group.id !== current.provider) continue;
        const model = (group.models ?? []).find((candidate) => candidate.id === current.model);
        if (model !== undefined) return { group, model };
      }
      return undefined;
    }

    function reasoningOf(state) {
      return currentModelOf(state)?.model?.reasoning;
    }

    function modelNameOf(state, t) {
      const current = state.current;
      if (current === null || current === undefined) {
        return state.status === 'loading' ? t('panel.loading') : t('panel.selectModel');
      }
      return currentModelOf(state)?.model?.name ?? current.model;
    }

    function effortLabelOf(state, t) {
      const current = state.current;
      if (current === null || current === undefined) return undefined;
      const reasoning = reasoningOf(state);
      const effort = current.reasoningEffort ?? reasoning?.defaultEffort;
      if (effort === undefined) return reasoning === undefined ? undefined : t('panel.providerDefault');
      return reasoning?.efforts?.find((level) => level.id === effort)?.name ?? effort;
    }

    function summaryOf(state, t) {
      const name = modelNameOf(state, t);
      const effort = effortLabelOf(state, t);
      return effort === undefined ? name : `${name} · ${effort}`;
    }

    function toModelSelection(current) {
      if (current === null || current === undefined) return undefined;
      return {
        provider: current.provider,
        model: current.model,
        ...current.reasoningEffort === undefined ? {} : { reasoningEffort: current.reasoningEffort },
      };
    }

    function providerRank(id) {
      if (id === 'deepseek-account') return 0;
      if (id === 'deepseek-official') return 1;
      return 2;
    }

    function orderedGroups(groups) {
      return [...groups].sort((left, right) => providerRank(left.id) - providerRank(right.id));
    }

    function providerName(group, t) {
      if (group.id === 'deepseek-account') return t('model.accountProvider');
      return group.name ?? group.id;
    }

    function ModelRows({ state, t, disabled, onOpenModel, onOpenEffort, onRetry }) {
      const reasoning = reasoningOf(state);
      const busy = disabled || state.status === 'selecting';
      return h('div', null,
        h(ui.SelectRow, {
          label: t('panel.model'),
          value: modelNameOf(state, t),
          description: t('panel.modelHint'),
          disabled: busy,
          onClick: onOpenModel,
        }),
        reasoning === undefined ? null : h(ui.SelectRow, {
          label: t('panel.effort'),
          value: effortLabelOf(state, t) ?? t('panel.providerDefault'),
          description: t('panel.effortHint'),
          disabled: busy,
          onClick: onOpenEffort,
        }),
        state.status === 'error' ? h('div', null,
          h(ui.ErrorText, null, t('panel.modelError', { message: state.error ?? '' })),
          h(ui.Button, { variant: 'ghost', onClick: onRetry }, t('panel.retry')),
        ) : null,
      );
    }

    function ModelListView({ state, t, disabled, onPick, onRetry }) {
      const groups = orderedGroups(state.groups ?? []);
      const busy = disabled || state.status === 'selecting';
      if (groups.length === 0) {
        if (state.status === 'loading' || state.status === 'idle') {
          return h(ui.Note, null, h(ui.Loading, null, t('panel.loading')));
        }
        if (state.status === 'error') {
          return h('div', null,
            h(ui.ErrorText, null, t('panel.modelError', { message: state.error ?? '' })),
            h(ui.Button, { variant: 'ghost', onClick: onRetry }, t('panel.retry')),
          );
        }
        return h(ui.Note, null, t('panel.modelEmpty'));
      }
      return h('div', { className: 'gp-list' },
        state.status === 'error' ? h(ui.ErrorText, null, t('panel.modelError', { message: state.error ?? '' })) : null,
        groups.map((group) => h(React.Fragment, { key: group.id },
          h(ui.GroupHeading, null, providerName(group, t)),
          (group.models ?? []).map((model) => h(ui.ListRow, {
            key: `${group.id}/${model.id}`,
            title: model.name ?? model.id,
            selected: state.current?.provider === group.id && state.current?.model === model.id,
            disabled: busy,
            onClick: () => onPick(group, model),
          })),
        )),
        state.status === 'error' ? h(ui.Button, { variant: 'ghost', onClick: onRetry }, t('panel.retry')) : null,
      );
    }

    function EffortListView({ state, t, disabled, onPick }) {
      const current = state.current;
      if (current === null || current === undefined) return h(ui.Note, null, t('panel.selectModelFirst'));
      const reasoning = reasoningOf(state);
      if (reasoning === undefined) return h(ui.Note, null, t('panel.noEffort'));
      const options = [];
      if (reasoning.defaultEffort === undefined) options.push({ key: 'provider-default', id: undefined, name: t('panel.providerDefault') });
      for (const effort of reasoning.efforts ?? []) options.push({ key: `effort:${effort.id}`, id: effort.id, name: effort.name });
      if (options.length === 0) return h(ui.Note, null, t('panel.noEffort'));
      const effective = current.reasoningEffort ?? reasoning.defaultEffort;
      return h('div', { className: 'gp-list' },
        options.map((option) => h(ui.ListRow, {
          key: option.key,
          title: option.name,
          selected: effective === option.id,
          disabled: disabled || state.status === 'selecting',
          onClick: () => onPick(option.id),
        })),
      );
    }

    return {
      useDirectoryState,
      currentModelOf,
      reasoningOf,
      modelNameOf,
      effortLabelOf,
      summaryOf,
      toModelSelection,
      orderedGroups,
      providerName,
      ModelRows,
      ModelListView,
      EffortListView,
    };
  },
});
