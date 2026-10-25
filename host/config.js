/**
 * Plugin configuration for the Settings page.
 *
 * Both switches are volatile so the Settings page can change the plan-mode
 * prompt (and the fresh-session execution prompt) without restarting the Host.
 * The schema is imported from the DSH installation's own Schemastery, resolved
 * through the profile runtime.
 */

import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  injectBrainstormingPrompt: z.boolean().default(true).volatile(),
  injectUnlimitedBudgetPrompt: z.boolean().default(true).volatile(),
});
