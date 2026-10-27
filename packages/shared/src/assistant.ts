import { z } from 'zod';
import { ReportDraftContent, ReportSubmission } from './report';

export const AssistantState = z.strictObject({
  intent: z.enum(['report', 'incident', 'assistance', 'task_update', 'status', 'unsupported']).default('unsupported'),
  content: ReportDraftContent.default(() => ReportDraftContent.parse({})),
  title: z.string().trim().max(160).default(''),
  description: z.string().trim().max(2000).default(''),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  is_safety: z.boolean().default(false),
  issue_code: z.string().trim().regex(/^ISS-\d+$/).nullable().default(null),
  transition: z.enum(['in_progress', 'resolution_submitted']).default('in_progress'),
  note: z.string().trim().max(2000).default(''),
});
export type AssistantState = z.infer<typeof AssistantState>;

export function assistantMissing(state: AssistantState): string[] {
  if (state.intent === 'report') {
    const parsed = ReportSubmission.safeParse(state.content);
    return parsed.success ? [] : [...new Set(parsed.error.issues.map((i) => i.message))];
  }
  if (state.intent === 'incident' || state.intent === 'assistance') {
    return [state.title.length < 3 && 'Give this request a short title', state.description.length < 3 && 'Describe what happened, where, and the help you need'].filter((v): v is string => Boolean(v));
  }
  if (state.intent === 'task_update') {
    return [!state.issue_code && 'Which issue code should I update? (for example ISS-000001)', state.note.length < 3 && 'Describe what you did or what is being worked on'].filter((v): v is string => Boolean(v));
  }
  return ['Choose a shift report, incident, assistance request, task update, or status check'];
}

export interface AssistantView {
  id: string;
  version: number;
  state: AssistantState;
  engine: string;
  reply: string;
  missing: string[];
  ready: boolean;
  shift_id: string | null;
  expires_at: string;
  result: { kind: string; id: string; reference?: string; status?: string } | null;
}
