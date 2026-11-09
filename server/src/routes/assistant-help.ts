import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AssistantPageContext, DepartmentExperience, GENERIC_EXPERIENCE, type MicaAnswer, type Role } from '@sh/shared';
import { asUser, parseBody, svc, type AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import { askMica, plainEngine } from '../automation/mica';
import { currentRules } from '../automation/ai-rules';
import { micaFacts, micaRoster } from '../automation/mica-facts';
import { leaveDates } from '../automation/mica-dates';

const STAFF = ['employee','manager'] as const;
export const GUIDES: Record<string, { roles: readonly Role[]; text: string }> = {
  today: { roles: ['admin','manager','employee'], text: "Check your assigned duty shift, the endorsement window and open follow-ups. Prepare your shift endorsement before your shift ends. If the window has closed, ask your department head to allow a late endorsement." },
  reports: { roles: STAFF, text: "This list shows each shift endorsement and its approval status. Staff can edit drafts and endorsements returned for revision. Submitted endorsements wait for the department head's approval; approved ones are endorsed to the incoming shift." },
  report: { roles: ['employee'], text: "Record the tasks completed, unresolved concerns and pending tasks for the incoming shift. Say so plainly when there are none. Drafts save automatically. Review before submitting; the endorsement window is enforced by the system." },
  issues: { roles: STAFF, text: "Use the filters to find open concerns, items assigned to you and items for verification. Record what you observed and any reference number. Only the department head can verify that a concern is resolved." },
  issue: { roles: STAFF, text: "Read the concern's history before acting. Record progress, or mark it done with a factual note and an optional photo. A done item stays unverified until the department head checks it." },
  handover: { roles: ['employee'], text: "Read the approved endorsement from the outgoing shift, acknowledge it and take the checklist items that are yours. Acknowledging does not resolve a concern; open items carry over until verified." },
  schedule: { roles: ['manager'], text: "Set the duty shifts (for example AM, PM and night shifts), the endorsement windows and the minimum staff per shift, then assign staff. Check for overlaps, rest days and leave before assigning." },
  review: { roles: ['manager'], text: "Compare the staff member's original endorsement with Mica's draft and the unit records. Decide every flag, confirm links to existing concerns, then approve, decline or return it for revision. The AI never makes the decision." },
  records: { roles: ['manager'], text: "Add approved unit records: biomedical or maintenance reports, readiness checklists, duty rosters and hospital policies or memoranda. They help verify what an endorsement claims. Keep patient information in the chart." },
  departments: { roles: ['admin'], text: "Create the hospital's departments and units, then use Customize to set each unit's titles (for example Head Nurse), endorsement guidance, privacy guidance, concern categories and record types. Department heads set their own duty schedules." },
  users: { roles: ['admin'], text: "Create accounts for hospital personnel, choose the system role and assign the department. A unit's own titles do not change permissions. Deactivate accounts of personnel who should no longer sign in." },
  settings: { roles: ['admin'], text: "Set the system rules: escalation timing, AI retry limits, data retention, leave types and email templates. Keep endorsement content out of emails; they link back to the system instead." },
  integrations: { roles: ['admin'], text: "Connect Mica's AI and check automation runs, retries and notification deliveries. Email and SMS sending are not set up yet. System administrators see counts and statuses, not endorsement contents." },
  pipeline: { roles: ['admin'], text: "See what Mica sent to the AI for each endorsement (with names as codes and private details removed), the checks it passed, or try an example. The department head always decides whether to approve." },
  audit: { roles: ['admin','manager'], text: "Use the filters to see recorded actions within your authorized scope. The audit log cannot be edited." },
  profile: { roles: ['admin','manager','employee'], text: "Update your profile photo and notification preferences. Your system role and department are managed by the system administrator." },
  notifications: { roles: ['admin','manager','employee'], text: "Open a notification to see the related record. Notifications link to pages you are already allowed to open." },
  my_schedule: { roles: ['employee'], text: "My schedule shows your duty shifts, rest days, days off and leave. Pending leave is not approved yet. Your department head sets the schedule; ask them about changes. Switch between the list and the calendar to plan ahead." },
  leave: { roles: STAFF, text: "Choose the leave type and whole days, add a reason when the type requires one, and file the request. Your department head decides; pending leave does not change your schedule until it is approved. You can cancel a request while it is pending. Mica can prepare the dates, but you file it on this page." },
  leave_requests: { roles: ['manager'], text: "Each pending request shows the duty shifts it affects and the staffing left if you approve. Approving removes the person from those shifts and alerts you to any gap; declining needs a note. You cannot decide your own leave. Mica can summarize the impact, but the decision is yours." },
  assistant: { roles: ['admin','manager','employee'], text: "Mica is the AI of Silent Handover. Ask about the current page and your own records. Staff can also prepare shift endorsements, concerns, requests for assistance, task updates and leave dates. Review everything Mica prepares and confirm it yourself before it is recorded." },
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
    const guide = { ...GUIDES[body.page]! };
    if (!guide.roles.includes(profile.role)) throw new ApiError(403, 'forbidden', 'This page is outside your role');
    // The guides use general words; say what this department calls things, so answers use its terms.
    if (profile.department_id) {
      const [d] = await asUser(c, (q) => q.query<{ experience: unknown }>('select experience from public.departments where id = app.my_department()'));
      const e = DepartmentExperience.parse(d?.experience ?? {});
      const g = GENERIC_EXPERIENCE;
      const words = [
        e.issue_label !== g.issue_label && `concerns are called “${e.issue_label}s”`,
        e.report_label !== g.report_label && `shift endorsements are called “${e.report_label}s”`,
        e.staff_label !== g.staff_label && `staff are “${e.staff_label}”`,
        e.supervisor_label !== g.supervisor_label && `the department head is the “${e.supervisor_label}”`,
      ].filter(Boolean);
      if (words.length) guide.text = `${guide.text} In this department, ${words.join(', ')}.`;
    }
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
