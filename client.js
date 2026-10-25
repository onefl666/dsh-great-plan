window.__ModuleLoader__.load({
  id: '@local/dsh-great-plan',
  factory(require) {
    const NS = 'great-plan';

    const zh = {
      'trigger.label': '执行选项',
      'trigger.aria': '执行选项：选择模型、思考强度和执行方式',
      'panel.title': '执行选项',
      'panel.subtitle': '选择模型与计划的执行方式',
      'panel.back': '返回',
      'panel.close': '关闭',
      'panel.model': '模型',
      'panel.effort': '思考强度',
      'panel.modelHint': '当前会话使用的模型',
      'panel.effortHint': '所选模型的推理等级',
      'panel.loading': '加载中…',
      'panel.selectModel': '选择模型',
      'panel.selectModelFirst': '请先选择模型。',
      'panel.providerDefault': '提供商默认',
      'panel.retry': '重试',
      'panel.modelEmpty': '没有可用模型。',
      'panel.noEffort': '当前模型未提供思考强度。',
      'panel.modelError': '模型目录加载失败：{message}',
      'panel.subagentUnavailable': '子会话不支持切换模型。',
      'panel.applyNote': '模型选择会立即应用到当前会话。',
      'panel.actions.execute.title': '执行计划',
      'panel.actions.execute.description': '在当前会话中按所选模型继续执行',
      'panel.actions.compact.title': '压缩上下文并执行',
      'panel.actions.compact.description': '先压缩较早历史，再执行计划',
      'panel.actions.clear.title': '清空上下文并执行…',
      'panel.actions.clear.description': '停止当前回合，在新会话中执行计划',
      'compact.failed': '压缩未完成：{message}。即将继续执行计划…',
      'clear.title': '清空上下文并执行',
      'clear.warning': '此操作会停止当前回合，并在同一工作区创建新会话执行计划。当前会话会保留，不会归档。',
      'clear.preset': '新会话 Agent 模式',
      'clear.titleLabel': '新会话标题',
      'clear.autoTitle': '将自动生成标题',
      'clear.model': '模型与思考强度',
      'clear.busy': '正在创建新会话…',
      'clear.confirm': '创建新会话并执行',
      'clear.kept': '旧会话会保留，可在列表中重新打开。',
      'clear.titleSuffix': ' · 执行计划',
      'clear.promptIntro': '用户已批准以下计划。请立即开始执行，不要重新规划。遵循计划中的证据与交接：复用已经确认的调研结果，不要重复调查；对标记为未验证或假设的内容先做核实。',
      'preset.title': '选择 Agent 模式',
      'preset.loading': '正在加载 Agent 模式…',
      'preset.unavailable': '当前部署没有可选的 Agent 模式，将使用默认模式。',
      'preset.error': 'Agent 模式加载失败：{message}',
      'preset.retry': '重试',
      'preset.default': '默认模式',
      'preset.standard': '标准模式',
      'preset.ptc': 'PTC 模式',
      'preset.minimal': '精简模式',
      'preset.cordis': '创建者模式',
      'preset.standardDescription': '使用代码、文件和信息完成任务。',
      'preset.ptcDescription': '适合批量调用工具并整理结果。',
      'preset.minimalDescription': '精简工具集，支持自动压缩历史。',
      'preset.cordisDescription': '创建插件或 Agent 预设。',
      'model.accountProvider': 'DeepSeek 账户',
      'error.reviewGone': '计划审核已结束，无法继续操作。',
      'error.approveFailed': '执行计划失败：{message}',
      'error.selectModelFailed': '应用模型选择失败：{message}',
      'error.freshFailed': '新会话执行失败：{message}',
      'settings.nav': '卓越计划',
      'settings.heading': '计划提示词',
      'settings.brainstorm.title': '注入头脑风暴提示词',
      'settings.brainstorm.description': 'plan 模式下，当需求存在会改变方案的歧义时，先逐轮提出一个简短问题，再给出建议与权衡。关闭后仍保留证据链与执行交接提示。',
      'settings.budget.title': '注入 token 预算无上限提示词',
      'settings.budget.description': 'plan 模式与新会话执行时，提示模型 token 预算无上限，不要为节省用量而减少调研、工具调用或必要提问；最终计划与总结仍保持简洁。',
      'settings.loading': '正在读取设置…',
      'settings.unavailable': '当前部署未提供该设置项。',
      'settings.readOnly': '当前配置不可写入。',
      'settings.saveFailed': '保存失败，请重试。',
    };

    const en = {
      'trigger.label': 'Execution options',
      'trigger.aria': 'Execution options: choose the model, reasoning effort, and execution method',
      'panel.title': 'Execution options',
      'panel.subtitle': 'Choose the model and how to execute the plan',
      'panel.back': 'Back',
      'panel.close': 'Close',
      'panel.model': 'Model',
      'panel.effort': 'Reasoning effort',
      'panel.modelHint': 'Model used by this session',
      'panel.effortHint': 'Reasoning level for the selected model',
      'panel.loading': 'Loading…',
      'panel.selectModel': 'Select model',
      'panel.selectModelFirst': 'Select a model first.',
      'panel.providerDefault': 'Provider default',
      'panel.retry': 'Retry',
      'panel.modelEmpty': 'No models available.',
      'panel.noEffort': 'This model provides no reasoning levels.',
      'panel.modelError': 'Model catalog failed to load: {message}',
      'panel.subagentUnavailable': 'Model switching is unavailable in subagent sessions.',
      'panel.applyNote': 'Model changes apply to this session immediately.',
      'panel.actions.execute.title': 'Execute plan',
      'panel.actions.execute.description': 'Continue in this session with the selected model',
      'panel.actions.compact.title': 'Compact and execute',
      'panel.actions.compact.description': 'Compact older history, then execute the plan',
      'panel.actions.clear.title': 'Start fresh and execute…',
      'panel.actions.clear.description': 'Stop this turn and execute the plan in a new session',
      'compact.failed': 'Compaction did not complete: {message}. Continuing to execute the plan…',
      'clear.title': 'Start fresh and execute',
      'clear.warning': 'This stops the current turn and creates a new session in the same workspace to execute the plan. The current session is kept and is not archived.',
      'clear.preset': 'New session agent preset',
      'clear.titleLabel': 'New session title',
      'clear.autoTitle': 'A title will be generated',
      'clear.model': 'Model and reasoning effort',
      'clear.busy': 'Creating the new session…',
      'clear.confirm': 'Create session and execute',
      'clear.kept': 'The previous session is kept and can be reopened from the list.',
      'clear.titleSuffix': ' · Execute plan',
      'clear.promptIntro': 'The user approved the following plan. Execute it now without re-planning. Follow the plan\'s evidence and handoff: reuse what it already establishes instead of repeating the investigation, and verify what it marks as unverified or assumed.',
      'preset.title': 'Choose an agent preset',
      'preset.loading': 'Loading agent presets…',
      'preset.unavailable': 'No agent presets are available in this deployment; the default preset will be used.',
      'preset.error': 'Agent presets failed to load: {message}',
      'preset.retry': 'Retry',
      'preset.default': 'Default preset',
      'preset.standard': 'Standard',
      'preset.ptc': 'PTC',
      'preset.minimal': 'Minimal',
      'preset.cordis': 'Creator',
      'preset.standardDescription': 'Work with code, files, and information.',
      'preset.ptcDescription': 'Call tools in batches and organize the results.',
      'preset.minimalDescription': 'A small tool set with automatic history compaction.',
      'preset.cordisDescription': 'Create plugins or agent presets.',
      'model.accountProvider': 'DeepSeek Account',
      'error.reviewGone': 'The plan review has ended.',
      'error.approveFailed': 'Executing the plan failed: {message}',
      'error.selectModelFailed': 'Applying the model selection failed: {message}',
      'error.freshFailed': 'The fresh-session execution failed: {message}',
      'settings.nav': 'Great Plan',
      'settings.heading': 'Plan prompt',
      'settings.brainstorm.title': 'Inject brainstorming prompt',
      'settings.brainstorm.description': 'In plan mode, ask one short question at a time when ambiguity could change the approach, then summarize recommendations and tradeoffs. Turning this off keeps the evidence chain and execution handoff guidance.',
      'settings.budget.title': 'Inject unlimited token budget prompt',
      'settings.budget.description': 'In plan mode and fresh-session execution, tell the model its token budget is unlimited and not to cut investigation, tool calls, or necessary questions to save tokens. Plans and summaries stay concise.',
      'settings.loading': 'Loading settings…',
      'settings.unavailable': 'This preference is unavailable in the current deployment.',
      'settings.readOnly': 'This preference is read-only in the current configuration.',
      'settings.saveFailed': 'Could not save. Please try again.',
    };

    return {
      inject: [
        'slots',
        'locale',
        'sessions',
        'modelDirectories',
        'remote',
        'remote.session',
        'remote.commands',
        'remote.agentPresets',
        'uiWorkspace',
      ],
      async apply(ctx) {
        const ui = await require.async('./client.ui.js');
        const settings = await require.async('./client.settings.js');
        await require.async('./client.model.js');
        const preset = await require.async('./client.preset.js');
        const actions = await require.async('./client.actions.js');
        const panel = await require.async('./client.panel.js');

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'great-plan: dictionaries');
        ctx.effect(() => ui.installStyles(), 'great-plan: styles');

        const presetStore = preset.createPresetStore(ctx);
        const t = ctx.locale.bind(NS);

        // The shared configuration forms back both the Settings page and the
        // fresh-session budget reminder; without them both default to enabled.
        const configForms = ctx.get('configForms');
        const readUnlimitedBudget = () => settings.readBudgetSwitch(configForms);

        ctx.slots.inject('conversation.plan-review.actions', () => ctx.slots.register({
          name: 'conversation.plan-review.actions',
          id: 'great-plan-execute-options',
          order: -2,
          locale: NS,
          inject: (sessionId) => ({
            directory: ctx.modelDirectories.directoryFor(sessionId),
            actions: actions.createActions(ctx, sessionId, readUnlimitedBudget),
            presetStore,
            modelAvailable: ctx.sessions.subagentAddress(sessionId) === undefined,
          }),
        }, panel.ExecutionTrigger));

        if (configForms !== undefined) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'great-plan',
            order: 25,
            label: () => t('settings.nav'),
            locale: NS,
            inject: () => ({ form: configForms.get('great-plan') }),
          }, settings.GreatPlanSection));
        }
      },
    };
  },
});
