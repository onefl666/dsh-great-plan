import { createCompactCommand } from './host/plan-compaction.js';
import { registerPlanEvidenceSection } from './host/plan-evidence.js';

export function apply(ctx) {
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
  }));
}
