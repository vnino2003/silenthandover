import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AssistantPageContext, type MicaAnswer, type Role } from '@sh/shared';
import { parseBody, svc, type AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import { askMica, plainEngine } from '../automation/mica';
import { currentRules } from '../automation/ai-rules';
import { micaFacts, micaRoster } from '../automation/mica-facts';
import { leaveDates } from '../automation/mica-dates';

const STAFF = ['employee','manager'] as const;
export const GUIDES: Record<string, { roles: readonly Role[]; text: string }> = {
  today: { roles: ['admin','manager','employee'], text: 'Check your assigned shift, reporting window and open follow-ups. Prepare your handover from the current shift. If a window has closed, ask your supervisor for a reporting override.' },
  reports: { roles: STAFF, text: 'Reports show the current review status. Employees can edit drafts and requested revisions. Submitted reports await supervisor review; approved handovers are delivered to the incoming team.' },
  report: { roles: ['employee'], text: 'Record completed work, unresolved concerns and next-team follow-ups. Explicitly say when there are none. Drafts save automatically. Review before submission; the database enforces reporting windows.' },
  issues: { roles: STAFF, text: 'Use the filters to find active concerns, assignments and items awaiting verification. Record what was observed and any approved reference. Only an authorized supervisor can verify resolution.' },
  issue: { roles: STAFF, text: 'Read the issue history before taking action. Record progress or submit completion with a factual note and optional evidence. Completion remains an unverified claim until a supervisor checks it.' },
  handover: { roles: ['employee'], text: 'Read the approved handover, acknowledge it and take ownership of relevant checklist items. Acknowledgment does not resolve an issue. Open items carry forward until verified.' },
  schedule: { roles: ['manager'], text: 'Configure operating hours, shift patterns and reporting windows, then assign team members. Use three shifts for continuous coverage or define patterns suited to your department. Check overlaps before assigning.' },
  review: { roles: ['manager'], text: 'Compare the employee’s original with the prepared draft and supporting source records. Resolve every flag, confirm issue links, then approve, reject or request revision. AI cannot make the review decision.' },
  records: { roles: ['manager'], text: 'Add authorized operational, staffing, quality, maintenance or policy references. These help reviewers verify claims. Record a source reference and factual details; keep confidential information in its approved system.' },
  departments: { roles: ['admin'], text: 'Create departments and teams, then use Customize to set role terminology, report guidance, privacy guidance, concern categories and source-record types. Supervisors configure their own schedules and reporting windows.' },
  users: { roles: ['admin'], text: 'Create accounts, choose the system role and assign the correct department. Department-specific display labels do not change permissions. Deactivate accounts that should no longer sign in.' },
  settings: { roles: ['admin'], text: 'Configure escalation timing, automation limits and notification templates. Changes affect operational checks. Keep sensitive report content out of messages and link back to the authenticated workspace.' },
  integrations: { roles: ['admin'], text: 'Connect the AI provider and inspect automation events, retries and deliveries. Simulated deliveries are not sent. Administrators see operational metadata rather than employee report contents.' },
  pipeline: { roles: ['admin'], text: 'Inspect censored analysis inputs and validation steps, or run a synthetic example. Original employee content and identity mappings remain restricted. A supervisor always decides whether to approve a handover.' },
  audit: { roles: ['admin','manager'], text: 'Use audit filters to inspect recorded actions within your authorized scope. History is append-only and cannot be edited here.' },
  profile: { roles: ['admin','manager','employee'], text: 'Update your profile photo and notification preferences. Your system role and department are managed by an administrator.' },
  notifications: { roles: ['admin','manager','employee'], text: 'Open an alert to see its related record. Notifications link to authenticated screens and do not grant additional access.' },
  my_schedule: { roles: ['employee'], text: 'My schedule shows your assigned shifts, rest days, days off and leave. Pending leave is not approved yet. Your supervisor sets shifts and rest days; ask them about changes. Switch between the list and the calendar to plan ahead.' },
  leave: { roles: STAFF, text: 'Choose a leave type and whole days, add a reason when the type needs one, and submit. Your supervisor decides; pending leave does not change your schedule until it is approved. You can cancel a request while it is pending. Mica can prepare the dates for you, but you submit on this page.' },
  leave_requests: { roles: ['manager'], text: 'Each pending request shows the shifts it would affect and the coverage left if you approve. Approving removes the person from those shifts and alerts you about any gap; declining needs a note. You cannot decide your own leave. Mica can summarize the impact, but the decision is yours.' },
  admin_schedules: { roles: ['admin'], text: 'A read-only view of every department board: coverage, conflicts, rest days and leave. Supervisors make schedule changes in their own department.' },
  admin_leave: { roles: ['admin'], text: 'Leave requests from supervisors whose department has no other active supervisor come here. Check the staffing impact, then approve or decline with a note. Leave reasons stay private to the requester and the decider.' },
  assistant: { roles: ['admin','manager','employee'], text: 'Mica is the AI of Silent Handover. Ask about the current page and your own records. Team members can also prepare reports, incidents, assistance requests, task updates and leave dates. Review every prepared action and confirm it yourself before it is recorded.' },
};
/** A question about the user's own records, answered by the app from those records, not by the AI. */
const RECORDS_QUESTION = /\b(my|next|when|which|who|status|coverage|pending|week|short|flags?|decision|records|attention|today|tomorrow)\b/i;
const LEAVE_REQUEST = /\b(request|prepare|apply|need|want|take|file)\b.*\b(leave|off|time off)\b/i;

export function assistantHelpRoutes() {
  const r = new Hono<AppEnv>();
  // Ask Mica. The facts come from the records this user can already open and are shown by the app;
  // they are never sent to the AI provider. The AI only explains the page (askMica).
  r.post('/assistant/help', bodyLimit({ maxSize: 16_384 }), async (c) => {
    c.header('Cache-Control', 'no-store');
    const body = await parseBody(c, z.strictObject({ message: z.string().trim().min(1).max(2000), page: AssistantPageContext, entity_id: z.uuid().optional() }));
    const profile = c.get('profile');
    const guide = GUIDES[body.page]!;
    if (!guide.roles.includes(profile.role)) throw new ApiError(403, 'forbidden', 'This page is outside your role');
    const facts = await micaFacts(c, body.page, body.entity_id);
    const base = { page: body.page, facts, checked_at: new Date().toISOString() };

    // Leave dates are worked out here, so a leave message (which often carries a medical reason)
    // never reaches the provider. The Leave form still collects the reason and submits.
    if (profile.role !== 'admin' && (body.page === 'leave' || LEAVE_REQUEST.test(body.message))) {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: profile.department_timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const dates = leaveDates(body.message, today);
      return c.json({
        ...base,
        engine: plainEngine(facts),
        fallback: false,
        reply: dates
          ? 'I found the dates below. Check them, choose the leave type and add any reason in the Leave form. Nothing has been submitted.'
          : guide.text,
        notices: ['Leave messages and reasons stay out of AI requests.'],
        ...(dates ? { leave_draft: dates, facts: [{ title: 'Proposed dates · review before requesting', items: [{ label: 'Leave dates', value: `${dates.start_date} – ${dates.end_date}`, link: '/leave' }] }, ...facts] } : {}),
      } satisfies MicaAnswer);
    }
    if (facts.some((g) => g.items.length) && RECORDS_QUESTION.test(body.message)) {
      return c.json({ ...base, engine: 'records', fallback: false, notices: [], reply: 'Here is what your authorized records show. Open a source to continue in the existing workflow.' } satisfies MicaAnswer);
    }
    const services = svc(c);
    const answer = await askMica(
      services.aiSettings,
      services.fetchImpl,
      services.config.AI_REQUEST_TIMEOUT_MS,
      { kind: profile.role, page: body.page, guide: guide.text, question: body.message, roster: await micaRoster(c), orgRules: await currentRules(services.db) },
      services.log,
    );
    return c.json({ ...base, ...answer } satisfies MicaAnswer);
  });
  return r;
}
