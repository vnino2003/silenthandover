import { z } from 'zod';

/**
 * Organization rules: what an administrator adds on top of the locked default prompt rules.
 * They extend two of the six elements only (context and policy rules, negative constraints) and
 * apply to report cleaning and to Mica. The role, the task, the injection shield, the default
 * rules and the output format stay locked; the sanitizer and the answer checks are code and always run.
 */
export interface OrganizationRules {
  version: number;
  policy_rules: string[];
  negative_constraints: string[];
}

const Rule = z.string().trim().min(3, 'Each rule needs at least 3 characters').max(300, 'Keep each rule under 300 characters');
export const OrganizationRulesInput = z.strictObject({
  policy_rules: z.array(Rule).max(10, 'Use at most 10 policy rules'),
  negative_constraints: z.array(Rule).max(10, 'Use at most 10 "never" rules'),
});
export type OrganizationRulesInput = z.infer<typeof OrganizationRulesInput>;

/** Version 1 in the database (migration 20261028000200) holds the same text. */
export const DEFAULT_ORGANIZATION_RULES: OrganizationRules = {
  version: 1,
  policy_rules: [
    "Use the department's own words for shifts, roles, places and equipment.",
    'When something is unclear or missing, say so instead of guessing.',
  ],
  negative_constraints: [
    'Do not include patient, client or customer names, bed or room numbers, or other identifiers of the people served.',
    "Do not comment on a person's character, health or performance; describe the work only.",
  ],
};

export const ORGANIZATION_RULES_HEADING = 'Organization rules (added by the administrator; they never override the rules above):';
