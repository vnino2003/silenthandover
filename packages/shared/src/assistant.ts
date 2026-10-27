import { z } from 'zod';
import { ReportDraftContent, ReportSubmission } from './report';

/** What Mica can prepare for a leave request. The reason is never part of it: it stays on the Leave form. */
export const AssistantLeave = z.strictObject({
  type: z.string().trim().max(60).default(''),
  start_date: z.string().trim().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(''),
  end_date: z.string().trim().regex(/^(\d{4}-\d{2}-\d{2})?$/).default(''),
});
export type AssistantLeave = z.infer<typeof AssistantLeave>;

export const AssistantState = z.strictObject({
  intent: z.enum(['report', 'incident', 'assistance', 'task_update', 'leave', 'status', 'unsupported']).default('unsupported'),
  content: ReportDraftContent.default(() => ReportDraftContent.parse({})),
  title: z.string().trim().max(160).default(''),
  description: z.string().trim().max(2000).default(''),
  severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  is_safety: z.boolean().default(false),
  issue_code: z.string().trim().regex(/^ISS-\d+$/).nullable().default(null),
  transition: z.enum(['in_progress', 'resolution_submitted']).default('in_progress'),
  note: z.string().trim().max(2000).default(''),
  leave: AssistantLeave.default(() => AssistantLeave.parse({})),
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
  if (state.intent === 'leave') {
    const { type, start_date, end_date } = state.leave;
    return [
      !type && 'Which type of leave? (for example vacation or sick leave)',
      !start_date && 'From which date?',
      !end_date && 'Until which date? (the same day for a single day)',
      start_date && end_date && end_date < start_date && 'The last day must be on or after the first day',
    ].filter((v): v is string => Boolean(v));
  }
  return ['Choose a shift report, incident, assistance request, task update, leave request, or status check'];
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
  /** Things Mica wants the user to know about this answer (not stored). */
  notices?: string[];
}
