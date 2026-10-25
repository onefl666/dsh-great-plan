window.__ModuleLoader__.load({
  id: '@local/dsh-great-plan',
  chunk: 'client.settings.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ui = require('@local/dsh-great-plan/client.ui.js');

    /** Config fields shared with the Host prompt section. */
    const FIELDS = {
      brainstorming: 'injectBrainstormingPrompt',
      budget: 'injectUnlimitedBudgetPrompt',
    };

    /** Settings rows, in display order. */
    const ROWS = [
      { field: FIELDS.brainstorming, title: 'settings.brainstorm.title', description: 'settings.brainstorm.description' },
      { field: FIELDS.budget, title: 'settings.budget.title', description: 'settings.budget.description' },
    ];

    /** Read one switch value from a configuration form snapshot. */
    function readSwitchValue(snapshot, field) {
      return snapshot?.value?.[field] !== false;
    }

    /** Read the brainstorming switch value from a configuration form snapshot. */
    function readBrainstormingValue(snapshot) {
      return readSwitchValue(snapshot, FIELDS.brainstorming);
    }

    /** Read the unlimited-budget switch value from a configuration form snapshot. */
    function readBudgetValue(snapshot) {
      return readSwitchValue(snapshot, FIELDS.budget);
    }

    /**
     * Read the unlimited-budget switch through the shared configuration mirror.
     *
     * The Client uses this for the fresh-session execution prompt. A missing
     * settings capability, an unreadable form, or an unready snapshot keeps the
     * Host default (enabled) so execution never fails because of configuration.
     */
    function readBudgetSwitch(configForms) {
      try {
        if (configForms === undefined || configForms === null || typeof configForms.get !== 'function') return true;
        const form = configForms.get('great-plan');
        const snapshot = form !== undefined && form !== null && typeof form.getSnapshot === 'function'
          ? form.getSnapshot()
          : undefined;
        return readBudgetValue(snapshot);
      } catch {
        return true;
      }
    }

    /**
     * Settings page body: independent switches for the plan-mode prompt.
     *
     * The Host stays the fact source: accepted writes arrive through the shared
     * configuration form, and a refused write keeps the previous value visible.
     */
    function GreatPlanSection({ form, t }) {
      const snapshot = ui.useStore(form);
      const [busy, setBusy] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const ready = snapshot.status === 'ready';

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
        h('div', { className: 'gp-settings-heading' }, t('settings.heading')),
        snapshot.status === 'loading' ? h(ui.Loading, null, t('settings.loading')) : null,
        snapshot.status === 'unavailable' ? h(ui.Note, null, t('settings.unavailable')) : null,
        ready
          ? ROWS.map((row) => {
            const checked = readSwitchValue(snapshot, row.field);
            const title = t(row.title);
            return h('div', { key: row.field, className: 'gp-setting-row' },
              h('div', { className: 'gp-setting-copy' },
                h('div', { className: 'gp-setting-title' }, title),
                h('div', { className: 'gp-setting-desc' }, t(row.description)),
              ),
              h('button', {
                type: 'button',
                role: 'switch',
                className: ui.cx('gp-switch', checked && 'gp-switch-on'),
                'aria-checked': checked,
                'aria-label': title,
                disabled: busy || snapshot.writable === false,
                onClick: () => {
                  toggle(row.field, !checked);
                },
              }, h('span', { className: 'gp-switch-thumb' })),
            );
          })
          : null,
        ready && snapshot.writable === false ? h(ui.Note, null, t('settings.readOnly')) : null,
        failed ? h(ui.ErrorText, null, t('settings.saveFailed')) : null,
      );
    }

    return {
      FIELDS,
      ROWS,
      readSwitchValue,
      readBrainstormingValue,
      readBudgetValue,
      readBudgetSwitch,
      GreatPlanSection,
    };
  },
});
