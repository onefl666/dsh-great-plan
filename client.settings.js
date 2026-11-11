window.__ModuleLoader__.load({
  id: '@onefl666/dsh-great-plan',
  chunk: 'client.settings.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ui = require('@onefl666/dsh-great-plan/client.ui.js');

    /** Config fields shared with the Host prompt section and the fresh-session prompt. */
    const FIELDS = {
      brainstorming: 'injectBrainstormingPrompt',
      budget: 'injectUnlimitedBudgetPrompt',
      originalInstructions: 'includeOriginalUserInstructions',
      minimalContext: 'includeMinimalRuntimeContext',
    };

    const ROWS = [
      { field: FIELDS.brainstorming, title: 'settings.brainstorm.title', description: 'settings.brainstorm.description' },
      { field: FIELDS.budget, title: 'settings.budget.title', description: 'settings.budget.description' },
      { field: FIELDS.originalInstructions, title: 'settings.originalInstructions.title', description: 'settings.originalInstructions.description' },
      { field: FIELDS.minimalContext, title: 'settings.minimalContext.title', description: 'settings.minimalContext.description' },
    ];

    /** Read one switch value from a configuration form snapshot. */
    function readSwitchValue(snapshot, field) {
      return snapshot?.value?.[field] !== false;
    }

    /** Read the shared settings form snapshot, or undefined when the capability is unavailable. */
    function readFormSnapshot(configForms) {
      if (configForms === undefined || configForms === null || typeof configForms.get !== 'function') return undefined;
      const form = configForms.get('great-plan');
      if (form === undefined || form === null || typeof form.getSnapshot !== 'function') return undefined;
      return form.getSnapshot();
    }

    /**
     * Read every fresh-session prompt switch from one snapshot.
     *
     * The Client composes one first message, so all three booleans must come
     * from the same form snapshot. Any unavailable or unreadable configuration
     * keeps the Host defaults (all enabled).
     */
    function readFreshPromptSwitches(configForms) {
      try {
        const snapshot = readFormSnapshot(configForms);
        return {
          unlimitedBudget: readSwitchValue(snapshot, FIELDS.budget),
          includeOriginalInstructions: readSwitchValue(snapshot, FIELDS.originalInstructions),
          includeMinimalContext: readSwitchValue(snapshot, FIELDS.minimalContext),
        };
      } catch {
        return { unlimitedBudget: true, includeOriginalInstructions: true, includeMinimalContext: true };
      }
    }

    /** Stable id for one row's description element (referenced by `aria-describedby`). */
    function descriptionId(field) {
      return `gp-setting-desc-${field}`;
    }

    /**
     * Settings page section entry point.
     *
     * The slot may render this component without a settings capability (or with
     * a form that never became readable). This wrapper stays hook-free: it either
     * renders the static unavailable copy or delegates to `GreatPlanForm`, which
     * owns the store subscription and the busy/failure state.
     */
    function GreatPlanSection({ form, t }) {
      if (form === undefined || form === null || typeof form.getSnapshot !== 'function') {
        return h('div', { className: 'gp-settings' },
          h('h2', { className: 'gp-settings-heading' }, t('settings.heading')),
          h(ui.Note, null, t('settings.unavailable')),
        );
      }
      return h(GreatPlanForm, { form, t });
    }

    /**
     * Settings page body: independent switches for the plan prompt and the
     * fresh-session execution prompt.
     *
     * The Host stays the fact source: accepted writes arrive through the shared
     * configuration form, and a refused write keeps the previous value visible.
     * Each switch that is off also offers a ghost button that writes the default
     * (on) value back.
     */
    function GreatPlanForm({ form, t }) {
      const snapshot = ui.useStore(form) ?? {};
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const status = snapshot.status;
      const ready = status === 'ready';
      const loading = status === 'loading' || status === 'idle';
      const unavailable = !ready && !loading;
      const writable = snapshot.writable !== false;

      const toggle = async (field, next) => {
        if (busy) return;
        setFailed(false);
        setBusy(true);
        try {
          const accepted = await form.set(field, next);
          if (!accepted) setFailed(true);
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'gp-settings' },
        h('h2', { className: 'gp-settings-heading' }, t('settings.heading')),
        loading ? h(ui.Loading, null, t('settings.loading')) : null,
        unavailable ? h(ui.Note, null, t('settings.unavailable')) : null,
        ready
          ? ROWS.map((row) => {
            const checked = readSwitchValue(snapshot, row.field);
            const title = t(row.title);
            const descId = descriptionId(row.field);
            const disabled = busy || !writable;
            return h('div', { key: row.field, className: 'gp-setting-row' },
              h('div', { className: 'gp-setting-copy' },
                h('div', { className: 'gp-setting-title' }, title),
                h('div', { className: 'gp-setting-desc', id: descId }, t(row.description)),
              ),
              h('div', { className: 'gp-setting-controls' },
                checked === false ? h(ui.Button, {
                  variant: 'ghost',
                  className: 'gp-setting-reset',
                  'aria-label': t('settings.resetAria', { title }),
                  disabled,
                  onClick: () => {
                    toggle(row.field, true);
                  },
                }, t('settings.reset')) : null,
                h('button', {
                  type: 'button',
                  role: 'switch',
                  className: ui.cx('gp-switch', checked && 'gp-switch-on'),
                  'aria-checked': checked,
                  'aria-label': title,
                  'aria-describedby': descId,
                  disabled,
                  onClick: () => {
                    toggle(row.field, !checked);
                  },
                }, h('span', { className: 'gp-switch-thumb' })),
              ),
            );
          })
          : null,
        ready && !writable ? h(ui.Note, null, t('settings.readOnly')) : null,
        failed ? h(ui.ErrorText, null, t('settings.saveFailed')) : null,
      );
    }

    return {
      FIELDS,
      ROWS,
      readSwitchValue,
      readFreshPromptSwitches,
      GreatPlanSection,
      GreatPlanForm,
    };
  },
});
