import { createCompactCommand } from './plan-compaction.js';
import { registerPlanEvidenceSection } from './plan-evidence.js';

export function apply(ctx, config) {
  ctx.inject(['commands'], (scope) => {
    return scope.commands.register(createCompactCommand({
      getProjections: () => ctx.get('sessionProjections'),
      getCompaction: () => ctx.get('compaction'),
      getBalancedAfter: async () => (await import('@deepseek-ai/dsh-compaction')).toolPairingBalancedAfter,
    }));
  });

  ctx.inject(['systemPrompt'], (scope) => registerPlanEvidenceSection({
    systemPrompt: scope.systemPrompt,
    getPlanMode: () => ctx.get('planMode'),
    getConfig: () => config,
  }));

  // The plugin ships its own Settings page, so no schema-derived page is offered.
  ctx.inject(['settings'], (scope) => {
    return scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), 'great-plan: settings presentation');
  });
}
