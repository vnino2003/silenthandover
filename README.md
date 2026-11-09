# Silent Handover — industry-independent continuity

Silent Handover helps teams turn shift notes into a reviewed handover and carry open work forward. Departments configure their own terminology, report guidance, privacy guidance, concern categories, source-record types, schedules and reporting windows. The shared permission model, explicit confirmations, supervisor review and resolution verification remain enforced.

## Nursery demo

The synthetic example is **Starlight Community Hospital — Nursery**. It focuses on operational continuity: unit readiness, equipment inspections, supplies, staffing briefings and facilities requests. It contains no actual patient data and does not provide diagnosis or treatment workflows.

The demo has 24-hour Day, Evening and Night patterns, a scheduled duty roster, unit records, open concerns and a prepared shift endorsement draft. A relative-time demonstration shift provides an open reporting window so the handover can be tried at any time. Every person, organization and reference is synthetic.

| Account | Email | Demo responsibility |
|---|---|---|
| Juan Dela Cruz | juan.delacruz@demo.test | Outgoing Nursing Attendant; continue the shift endorsement draft |
| Maria Santos | maria.santos@demo.test | Head Nurse; approve shift endorsements, arrange coverage and verify resolved concerns |
| Ana Lim | ana.lim@demo.test | Incoming care-team member |
| Ben Torres | ben.torres@demo.test | Incoming care-team member |
| Carla Mendoza | carla.mendoza@demo.test | Night care-team member |
| Daniel Ramos | daniel.ramos@demo.test | Night care-team member |
| Alex Reyes | admin@demo.test | Organization setup and integrations; cannot approve or read report content |

Local synthetic accounts use `demo-handover-2026`. Do not reuse this password outside the demo.

## Run locally

Requires Node 20.12 or newer. Run `npm install`, then `npm run dev`. Open [the app](http://localhost:5173). The API runs on port 8787 by default. First startup applies the SQL migrations and creates the hospital demo when the local database is empty.

To switch an older local demo, stop the local API and run `npm run demo:hospital`. It creates a separate newborn-care database, preserves the entire prior database including custom accounts and activity, and changes only `LOCAL_DB_DIR` in `backend/.env`. A configured encrypted AI connection is carried forward if present. This command is local-demo-only and does not run on hosted databases. The previous database can be reopened by restoring its former `LOCAL_DB_DIR` value.

For a presentation, `npm run presentation:prepare` (with the app stopped) builds a separate, clean database with a small set of real workflow activity and switches the local app to it; the current database is kept. See [docs/presentation-guide.md](docs/presentation-guide.md).

## Try the workflow

1. Sign in as Juan. Continue the prepared shift endorsement or open **Mica** using the small floating launcher. Mica can prepare a shift endorsement, incident, assistance request or task update without leaving the current page.
2. Review the preparation and explicitly confirm. Submission follows the same server-side validation and reporting-window rules as the standard form.
3. Sign in as Maria. Compare the original and AI draft, check source records, resolve flags and confirm issue links before approval.
4. Sign in as Ana or Ben. Read the approved shift endorsement, mark it received and take ownership of relevant checklist items. Completion claims wait for Maria's verification.
5. Open Departments as Alex and choose **Customize** to see the organization settings. A different organization can choose generic terminology and categories; hospital language is confined to this demo configuration.

## Scheduling and leave

Department heads (the Nursery's Head Nurse) plan staffing on **Duty schedule**: by shift, or by person with day / week / month views, coverage against each shift's minimum staff, and a list of conflicts. They decide **Leave requests** after seeing the staffing impact. Workers see **My schedule** (next shift first, list or calendar, rest days and leave) and request leave on **Leave**. Only approved leave changes the schedule, and nobody approves their own. Supervisors also see their whole **Team**. Administrators configure leave types and rules and set job titles, but do not see department schedules or anyone's leave; a supervisor's own leave is decided by another supervisor of the department. Every schedule change notifies the people affected.

For a two-week staffing example, run this while the local app is running:

```
npm run demo:schedule
```

Details and design decisions: `docs/plan-scheduling-and-leave.md`.

## Mica, the integrated assistant

Mica is an original teal messenger-bird companion. The compact panel stays on the current page and keeps a staff member's preparation across navigation. Page help uses the authenticated role and department configuration. It does not automatically transmit the page body, employee records or clinical information. Supervisors and administrators receive role-specific guidance; only employees can prepare employee actions.

With an administrator-connected Gemini/Grok provider, Mica can understand natural requests. Without one, it explicitly shows page-guide or guided preparation mode. Voice input creates an editable transcript and never submits automatically. Browser speech support and microphone permission are required; audio may be processed by the browser's speech service. See [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition).

## Commands and layout

| Command | Purpose |
|---|---|
| `npm run dev` | API and Vue web app |
| `npm test` | Shared, database/workflow, security, assistant and voice tests |
| `npm run typecheck` | Shared, server and web TypeScript checks |
| `npm run build` | Production server and web builds |
| `npm run demo:hospital` | Safely switch a prior local demo to the Nursery |
| `npm run seed -- --reset` | Destructive local-only reset; do not use to migrate custom data |
| `npm run prompt:eval -- --version 1.0` | Prompt regression against a configured live model |

`frontend` is Vue 3/Ionic Vue/Pinia/Router, with Tailwind for layout. `backend` is a Hono API. `packages/shared` owns Zod contracts and prompts. `supabase/migrations` defines PostgreSQL rules and RLS. `n8n` contains optional orchestration workflows. Local PGlite and hosted PostgreSQL use the same schema and permission checks.

## Accounts and email

The administrator adds people on **Users** without choosing a password. Each person gets an invitation email, opens its one-time link (valid 7 days) and chooses their own password; the same page sends a password reset link later. To make emails really go out, open **Integrations → Email → Connect email** and paste a Gmail App Password (free: turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords) or a Resend API key, send a test, and save. It is stored encrypted like the AI key. Until then, the administrator gets the link to pass on.

To start the real organization locally without any demo data, stop the app and run `npm run setup:live -- --admin you@gmail.com --name "Your Name"`. It creates a new empty database (the current one is kept), carries over the connected email and AI settings, and emails you an invitation as the only administrator. On a hosted server, set `FIRST_ADMIN_EMAIL` instead (see [deployment](docs/deployment.md)). Links point to `APP_BASE_URL`, so set it to the address people open (not `localhost` if they use other computers).

## Integration status

The UI, database workflow, privacy sanitizer, validation, retries, permission checks and audit records are implemented and covered by automated tests. Without a connected provider, analysis is a labeled simulator and email uses a labeled dev outbox. Hosted Supabase, live model calls, email/SMS and n8n require their own configured-service checks; a passing simulator test does not establish a live deployment.

See [architecture](docs/architecture.md), [database](docs/database.md), [security](docs/security.md), [API](docs/api.md), [deployment](docs/deployment.md), [industry upgrade](docs/industry-upgrade.md) and [capstone documents](docs/capstone/README.md).
