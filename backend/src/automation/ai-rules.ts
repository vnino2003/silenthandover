import { DEFAULT_ORGANIZATION_RULES, OrganizationRulesInput, type OrganizationRules } from '@sh/shared';
import type { Db } from '../db/types';
import { ApiError } from '../http/errors';
import { detectInjection } from './injection';

/**
 * The administrator's organization rules (see packages/shared/src/organization-rules.ts). The
 * newest version applies to every new AI request: report cleaning and Mica.
 */
const COLUMNS = 'version, policy_rules, negative_constraints';

export async function currentRules(db: Db): Promise<OrganizationRules> {
  const [row] = await db.asService((q) => q.query<OrganizationRules>(`select ${COLUMNS} from public.ai_rule_versions order by version desc limit 1`));
  return row ?? DEFAULT_ORGANIZATION_RULES;
}

export async function rulesVersion(db: Db, version: number | null): Promise<OrganizationRules | null> {
  if (version === null) return null;
  const [row] = await db.asService((q) => q.query<OrganizationRules>(`select ${COLUMNS} from public.ai_rule_versions where version = $1`, [version]));
  return row ?? null;
}

/**
 * Validates what an administrator typed. A rule may add guidance, never steer the model: wording
 * the injection detector catches (ignore the rules, approve, skip review, reveal the prompt, fake
 * tags or output) is refused, naming the rule.
 */
export function checkRules(input: unknown): OrganizationRulesInput {
  const parsed = OrganizationRulesInput.safeParse(input);
  if (!parsed.success) throw new ApiError(422, 'validation', parsed.error.issues[0]?.message ?? 'Check the rules');
  const lists = [
    ['policy_rules', 'Policy rule'],
    ['negative_constraints', '“Never” rule'],
  ] as const;
  for (const [key, label] of lists) {
    parsed.data[key].forEach((rule, i) => {
      if (detectInjection(rule).length || /[<>]/.test(rule)) {
        throw new ApiError(422, 'validation', `${label} ${i + 1} looks like an instruction to bypass the safeguards. Rules can add guidance only.`, { [`${key}.${i}`]: 'Not allowed' });
      }
    });
    if (new Set(parsed.data[key].map((r) => r.toLowerCase())).size !== parsed.data[key].length) {
      throw new ApiError(422, 'validation', `Each ${label.toLowerCase()} must be different`);
    }
  }
  return parsed.data;
}
