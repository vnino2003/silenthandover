# API reference

Base path `/api`. JSON in and out. Authenticated routes need `Authorization: Bearer <token>`.
Errors: `{ "error": { "code", "message", "fields"?, "request_id" } }`.

## Workplace assistant (active employees only)

Role-aware page help is separate: `POST /assistant/help` accepts `{message, page}` for any active role, validates page access for that role, and returns plain-text guidance with an explicit engine label. It has no action tools or access to arbitrary page content. Employee action preparations may include `{context: {page, entity_id?}}`; a report reference is resolved under author-scoped RLS before its shift is selected.

Department configuration: `GET /department/experience` reads the caller's own department settings (generic defaults for an unassigned administrator). `PUT /admin/departments/:id/experience` validates and persists terminology, guidance, concern categories and record choices; only administrators may write it.

| Method | Path | Purpose |
|---|---|---|
| POST | `/assistant/message` | `{ message, shift_id? }` starts preparation; `{ message, preparation_id, version }` continues it |
| GET | `/assistant/preparations/:id` | Restore the author's latest summary and receipt |
| PUT | `/assistant/preparations/:id` | Save `{ version, state }` after reviewing/editing; validates shared schemas and issue permissions |
| POST | `/assistant/preparations/:id/confirm` | `{ version, confirmed: true }` executes the reviewed server snapshot once; repeated confirmation returns the receipt |
| GET | `/assistant/status` | Own recent reports and authorized department issues from PostgreSQL |

Preparation responses include state, engine (`guided` when no model is connected), missing fields,
readiness, version, shift, expiry and an optional receipt. Message bodies are limited to 64 KB and
messages to 6000 characters. Existing authentication and write rate limits apply. Confirmation
does not accept client-authored action content. Unsupported actions never execute. Failures retain
the last preparation. Status data is read under RLS and never supplied as model-generated facts.

| Code | HTTP | Meaning |
|---|---|---|
| `unauthenticated` | 401 | Missing or expired session |
| `forbidden`, `not_assigned` | 403 | Role, department or assignment does not allow it |
| `not_found` | 404 | Missing, or not visible to you |
| `window_not_open`, `window_closed`, `already_submitted`, `not_editable`, `invalid_state`, `invalid_transition`, `conflict` | 409 | Not allowed in the current state |
| `validation`, `flags_unresolved` | 422 | Invalid input (`fields` lists them) |
| `rate_limited` | 429 | Slow down (`Retry-After`) |

## Public

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Database reachable |
| GET | `/config` | Mode, sign-in provider, truthful integration status; whether local demo tools are on (no account details are sent) |
| POST | `/auth/login` | Local mode only. `{ email, password }` → `{ token, expires_at }` |

## Everyone signed in

| Method | Path | Notes |
|---|---|---|
| GET | `/me` | Profile, department, server time |
| PATCH | `/me/preferences` | `{ notify_email, notify_sms, phone }` |
| GET | `/notifications` | Latest 50 + unread count |
| POST | `/notifications/read` | `{ ids: uuid[] \| null }` (null = all) |
| GET | `/department/staff` | Names and roles in your department |
| GET | `/audit` | Managers (own dept) and admins. `?entity_type&entity_id&action&limit` |

## Employee

| Method | Path | Notes |
|---|---|---|
| GET | `/employee/dashboard` | Current shift with authoritative `window_state`, upcoming, missed, revisions requested, incoming, tasks, recent |
| GET | `/employee/shifts` | Your shifts ±14 days |
| POST | `/shifts/:id/report` | Get or create your report for a shift (window rules apply) |
| GET | `/reports/mine` | Your reports |
| GET | `/reports/:id` | Your report: draft, revisions, decisions and notes, approved version, deliveries |
| PUT | `/reports/:id/draft` | `{ content }` autosave (draft or revision requested) |
| POST | `/reports/:id/submit` | `{ content }` final submission → `{ report_id, revision_no, event_id, is_late }` |
| GET | `/handovers/incoming` | Approved handovers delivered to you, each with `checklist`: live status of every problem and task in it |
| POST | `/handovers/:deliveryId/acknowledge` | `{ note }` — idempotent |

## Issues (employee and manager, own department)

| Method | Path | Notes |
|---|---|---|
| GET | `/issues?scope=active\|mine\|verification\|all` | |
| GET | `/issues/:id` | Issue + full history |
| POST | `/issues` | `{ title, description, severity, is_safety }` — employees create `reported`, managers `open` |
| POST | `/issues/:id/transition` | `{ to, note, photo? }` — state machine in `docs/architecture.md`. `photo` = `{ content_type: image/jpeg\|png\|webp, data_base64 }`, ≤ 3 MB |
| GET | `/issue-photos/:id` | The photo itself, if the issue is in your department |
| POST | `/issues/:id/notes` | `{ note, photo? }` |
| POST | `/issues/:id/assign` | Manager. `{ assignee_id \| null }` |

## Manager (own department)

| Method | Path | Notes |
|---|---|---|
| GET | `/manager/summary` | Counts for the queue header |
| GET | `/manager/queue` | Reports submitted, processing, pending review, revision requested |
| GET | `/manager/reports?status&days` | History |
| GET | `/manager/reports/:id` | Review workspace: revisions, runs (draft + flags, names restored), decisions, records, open issues, next shift, deliveries, sanitized AI input |
| POST | `/manager/reports/:id/decision` | `ReviewDecision` (see `packages/shared/src/approval.ts`) |
| POST | `/manager/reports/:id/reanalyze` | Queue a new analysis |
| GET | `/manager/shift-board?date=YYYY-MM-DD` | Shifts, assignees, report status, missing reports, acknowledgments |
| POST | `/manager/shifts/:id/override` | `{ employee_id, minutes, reason }` |
| GET/POST | `/manager/records` | Source records (`maintenance`, `inventory`, `dispatch`, `policy`) |
| GET/POST | `/manager/templates` · PATCH `/:id` · POST `/:id/generate` | Shift types; generate `{ from, to, supervisor_id }` |
| GET/POST | `/manager/schedule?from&to` · PATCH `/:id` | Shifts in your department; one-off shifts; cancel |
| POST/DELETE | `/manager/schedule/:id/assignments[/:employeeId]` | Who is on duty. Assigning also delivers waiting handovers |

## Admin

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/admin/users` · PATCH `/admin/users/:id` | Create = sign-in identity + profile |
| GET/POST | `/admin/departments` · PATCH `/:id` · POST `/:id/teams` | |
| GET/PUT | `/admin/settings[/:key]` · `/admin/notification-templates[/:key]` | |
| GET | `/admin/integrations` | Adapter status, events, deliveries, dev outbox (masked) |
| POST | `/admin/events/:id/retry` · `/admin/deliveries/:id/retry` · `/admin/tick` | |

## n8n callbacks (`Authorization: Bearer N8N_CALLBACK_SECRET`)

| Method | Path | Body |
|---|---|---|
| POST | `/integrations/n8n/analysis-result` | `{ event_id, attempt, status: "ok"\|"error", output?, error?, model?, latency_ms?, usage? }` → `{ result: "recorded"\|"invalid"\|"ignored" }` |
| POST | `/integrations/n8n/delivery-result` | `{ results: [{ delivery_id, attempt, status: "sent"\|"failed", provider, provider_message_id?, response?, error? }] }` |
| POST | `/integrations/n8n/tick` | `{}` → counts from `internal.scheduled_tick()` |

## Outbound to n8n

**Workflow A** (`N8N_ANALYSIS_WEBHOOK_URL`, header `X-Silent-Handover-Secret`, `Idempotency-Key`):
`{ event_id, attempt, idempotency_key, report_id, prompt_version, system_prompt, user_prompt, response_schema, callback_url }`

**Workflow B** (`N8N_DELIVERY_WEBHOOK_URL`):
`{ deliveries: [{ delivery_id, attempt, channel, to, subject, text, idempotency_key }], from, callback_url }`

**Optional SMS workflow** (`N8N_SMS_WEBHOOK_URL`):
`{ deliveries: [{ delivery_id, attempt, channel: "sms", to, text, idempotency_key }], from, callback_url }`.
It uses the same authenticated delivery-result callback and idempotency checks as email.

## Scheduling and leave

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | `/leave-types` | Signed in | Leave types configured by the administrator |
| GET / POST | `/leave` | Worker, supervisor | Own leave requests / request leave (whole days) |
| POST | `/leave/:id/cancel` | Requester | Cancel own pending request |
| GET | `/employee/schedule?from&to` | Worker | Own shifts, rest days, leave, next shift |
| GET | `/manager/board?from&to` | Supervisor | Department board: staff, shifts, coverage, rest days, leave (no reasons), conflicts |
| GET | `/manager/leave?scope=pending|all` | Supervisor | Department leave requests |
| GET | `/manager/leave/:id/impact` | Supervisor | Shifts the person would leave and the staffing left |
| POST | `/manager/leave/:id/decision` | Supervisor (not own) | Approve or decline (reason required to decline) |
| POST | `/manager/leave/:id/cancel` | Supervisor | Cancel approved or pending leave (reason required) |
| PUT | `/manager/day-marks` | Supervisor | Mark or clear a rest day / day off |
| POST | `/manager/rest-days` | Supervisor | Weekly rest days over a date range |
| PATCH | `/manager/templates/:id/min-staff`, `/manager/schedule/:id/min-staff` | Supervisor | Staff needed per shift pattern / shift |
| GET | `/admin/board?department_id&from&to` | Administrator | Read-only department board |
| GET / POST | `/admin/leave`, `/admin/leave/:id/decision` | Administrator | Supervisors' own leave when no other supervisor can decide |
| POST / PATCH | `/admin/leave-types` | Administrator | Configure leave types |
| PATCH | `/admin/users/:id/job-title` | Administrator | Job title shown on schedules |
