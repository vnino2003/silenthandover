import { z } from 'zod';
export const AssistantPageContext = z.enum(['today','reports','report','issues','issue','handover','schedule','review','records','departments','users','settings','integrations','pipeline','profile','notifications','audit','assistant','my_schedule','leave','leave_requests','attendance','team_attendance','dtr','payslips','hr','payroll']);
export type AssistantPageContext = z.infer<typeof AssistantPageContext>;
export const AssistantContext = z.strictObject({ page: AssistantPageContext, entity_id: z.uuid().optional() });
export type AssistantContext = z.infer<typeof AssistantContext>;

/** A fact Mica shows from the system's own records, written by the app (never by the AI). */
export interface MicaFact { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' | 'neutral'; link?: string }
export interface MicaFactGroup { title: string; items: MicaFact[]; empty?: string }

/** Mica's answer in the Ask panel. `engine` is the provider, or 'guide' when the plain fallback answered. */
export interface MicaAnswer {
  page: AssistantPageContext;
  reply: string;
  engine: string;
  fallback: boolean;
  facts: MicaFactGroup[];
  notices: string[];
  checked_at: string;
  leave_draft?: { start_date:string; end_date:string };
}

/** Runtime validation for the assistant's structured application response. */
export const MicaAnswer = z.strictObject({
  page:AssistantPageContext,
  reply:z.string().trim().min(1).max(2400),
  engine:z.string().max(100),
  fallback:z.boolean(),
  facts:z.array(z.strictObject({title:z.string().max(160),items:z.array(z.strictObject({label:z.string().max(200),value:z.string().max(2400),tone:z.enum(['ok','warn','bad','neutral']).optional(),link:z.string().regex(/^\/(?!\/)/).max(200).optional()})).max(100),empty:z.string().max(400).optional()})).max(12),
  notices:z.array(z.string().max(500)).max(8),
  checked_at:z.iso.datetime(),
  leave_draft:z.strictObject({start_date:z.iso.date(),end_date:z.iso.date()}).optional(),
});
