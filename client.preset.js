window.__ModuleLoader__.load({
  id: '@local/dsh-great-plan',
  chunk: 'client.preset.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ui = require('@local/dsh-great-plan/client.ui.js');

    const BUILTIN_NAMES = {
      standard: 'preset.standard',
      ptc: 'preset.ptc',
      minimal: 'preset.minimal',
      cordis: 'preset.cordis',
    };

    const BUILTIN_DESCRIPTIONS = {
      standard: 'preset.standardDescription',
      ptc: 'preset.ptcDescription',
      minimal: 'preset.minimalDescription',
      cordis: 'preset.cordisDescription',
    };

    function createPresetStore(ctx) {
      const store = ui.createStore({ status: 'idle', options: [], error: null });
      let inflight;

      async function load(force = false) {
        if (inflight !== undefined) return inflight;
        const state = store.getSnapshot();
        if (!force && state.status === 'ready') return undefined;
        store.set({ ...state, status: 'loading', error: null });
        inflight = (async () => {
          const presets = ctx.remote?.agentPresets;
          if (presets?.list === undefined) {
            store.set({ status: 'unavailable', options: [], error: null });
            return;
          }
          const result = await presets.list();
          if (!result.ok) {
            if (result.error.code === 'gateway/invocation-unavailable') {
              store.set({ status: 'unavailable', options: [], error: null });
              return;
            }
            store.set({ status: 'error', options: [], error: result.error.message });
            return;
          }
          const options = (result.value?.presets ?? [])
            .filter((preset) => preset.broken === undefined)
            .map((preset) => ({
              id: preset.id,
              name: preset.name,
              description: preset.description,
              isDefault: preset.isDefault === true,
            }));
          store.set({ status: options.length === 0 ? 'unavailable' : 'ready', options, error: null });
        })().catch((error) => {
          store.set({ status: 'error', options: [], error: ui.messageOf(error) });
        }).finally(() => {
          inflight = undefined;
        });
        return inflight;
      }

      return { store, load };
    }

    function usePresetState(store) {
      return ui.useStore(store);
    }

    function presetDisplay(option, t) {
      if (option?.name !== undefined && option.name !== '') return option.name;
      const key = option === undefined ? undefined : BUILTIN_NAMES[option.id];
      return key === undefined ? (option?.id ?? '') : t(key);
    }

    function presetDescription(option, t) {
      if (option?.description !== undefined && option.description !== '') return option.description;
      const key = option === undefined ? undefined : BUILTIN_DESCRIPTIONS[option.id];
      return key === undefined ? undefined : t(key);
    }

    function defaultPresetId(state) {
      return state.options.find((option) => option.isDefault === true)?.id;
    }

    function PresetOptions({ state, t, selectedId, onPick, onRetry }) {
      const options = state.options ?? [];
      const showLoading = state.status === 'loading' && options.length === 0;
      if (showLoading) return h(ui.Note, null, h(ui.Loading, null, t('preset.loading')));
      if (state.status === 'error' && options.length === 0) {
        return h('div', null,
          h(ui.ErrorText, null, t('preset.error', { message: state.error ?? '' })),
          h(ui.Button, { variant: 'ghost', onClick: onRetry }, t('preset.retry')),
        );
      }
      if (state.status === 'unavailable' || options.length === 0) return h(ui.Note, null, t('preset.unavailable'));
      return h('div', { className: 'gp-list' },
        state.status === 'error' ? h('div', null,
          h(ui.ErrorText, null, t('preset.error', { message: state.error ?? '' })),
          h(ui.Button, { variant: 'ghost', onClick: onRetry }, t('preset.retry')),
        ) : null,
        options.map((option) => h(ui.ListRow, {
          key: option.id,
          title: presetDisplay(option, t),
          description: presetDescription(option, t),
          selected: option.id === selectedId,
          onClick: () => onPick(option.id),
        })),
      );
    }

    return {
      createPresetStore,
      usePresetState,
      presetDisplay,
      presetDescription,
      defaultPresetId,
      PresetOptions,
    };
  },
});
