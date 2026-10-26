# API reference

Base path `/api`. JSON in and out. Authenticated routes need `Authorization: Bearer <token>`.
Errors: `{ "error": { "code", "message", "fields"?, "request_id" } }`.

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
| GET | `/config` | Mode, sign-in provider, truthful integration status; demo accounts in local demo mode only |
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
| GET | `/handovers/incoming` | Approved handovers delivered to you |
| POST | `/handovers/:deliveryId/acknowledge` | `{ note }` — idempotent |

## Issues (employee and manager, own department)

| Method | Path | Notes |
|---|---|---|
| GET | `/issues?scope=active\|mine\|verification\|all` | |
| GET | `/issues/:id` | Issue + full history |
| POST | `/issues` | `{ title, description, severity, is_safety }` — employees create `reported`, managers `open` |
| POST | `/issues/:id/transition` | `{ to, note }` — state machine in `docs/architecture.md` |
| POST | `/issues/:id/notes` | `{ note }` |
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

## Admin

| Method | Path | Notes |
|---|---|---|
| GET/POST | `/admin/users` · PATCH `/admin/users/:id` | Create = sign-in identity + profile |
| GET/POST | `/admin/departments` · PATCH `/:id` · POST `/:id/teams` | |
| GET/POST | `/admin/templates` · PATCH `/:id` · POST `/:id/generate` | `{ from, to, supervisor_id }` |
| GET/POST | `/admin/shifts?department_id&from&to` · PATCH `/:id` | One-off shifts, supervisor, cancel |
| POST/DELETE | `/admin/shifts/:id/assignments[/:employeeId]` | Assigning also delivers waiting handovers |
| GET/PUT | `/admin/settings[/:key]` · `/admin/notification-templates[/:key]` | |
| GET | `/admin/integrations` | Adapter status, events, deliveries, dev outbox (masked) |
| POST | `/admin/events/:id/retry` · `/admin/deliveries/:id/retry` · `/admin/tick` | |
| POST | `/admin/demo/timeline` | Local demo mode only |

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
