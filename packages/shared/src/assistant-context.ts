import { z } from 'zod';
export const AssistantPageContext = z.enum(['today','reports','report','issues','issue','handover','schedule','review','records','departments','users','settings','integrations','pipeline','profile','notifications','audit','assistant']);
export type AssistantPageContext = z.infer<typeof AssistantPageContext>;
export const AssistantContext = z.strictObject({ page: AssistantPageContext, entity_id: z.uuid().optional() });
export type AssistantContext = z.infer<typeof AssistantContext>;
