# Silent Handover — Architecture & Implementation Plan

This document was written before implementation and is kept in sync with the code.
Anything marked **(not yet verified live)** depends on an external service that has not
been connected in this repository.

## 1. Starting point

The repository was empty, so the structure below was created from scratch.

```
apps/web            Vue 3 + TypeScript + Vite + Tailwind + Pinia + Vue Router (all three portals)
server              Node.js API (Hono). Auth, validation, sanitization, n8n integration, scheduler
packages/shared     Zod schemas, status enums, labels, prompt builder — shared by web and server
supabase/migrations PostgreSQL schema, Row Level Security, workflow functions (authoritative rules)
n8n/workflows       Importable n8n workflow exports (A: AI processing, B: delivery, C: scheduled tick)
docs                Architecture, security, API, testing, deployment, TESDA capstone documents
```

## 2. Why a Node.js API instead of only Supabase Edge Functions

The brief allows either. A Node.js API (Hono) was chosen because:

* One codebase runs **locally with zero external accounts** (embedded PostgreSQL via PGlite,
  local test authentication, development adapters) *and* in production against Supabase
  (Supabase Postgres + Supabase Auth). The same SQL migrations and the same RLS policies run in both.
* The sanitizer, AI-output validator and grounding checks are plain TypeScript and are unit tested.
* Hono also runs on Deno, so moving routes into Supabase Edge Functions later is a port, not a rewrite.

## 3. Responsibilities

| Layer | Owns | Never does |
|---|---|---|
| **Browser (Vue)** | Forms, display, countdowns (cosmetic only) | Holds secrets, calls n8n, decides whether a window is open |
| **API (Hono)** | Token verification, Zod validation, rate limiting, PII sanitization, building the bounded prompt, dispatching to n8n/email, validating AI output, grounding checks | Bypasses the database's permission checks for user actions |
| **PostgreSQL** | The authoritative record: statuses, windows (`now()`), approvals, issue lifecycle, audit log. RLS on every table. Workflow mutations are `security definer` functions that check `auth.uid()` and role | Trusts client-supplied timestamps or roles |
| **n8n** | Orchestration: calls the AI model, sends email via Resend, calls back with results, runs the scheduled tick | Approves anything, writes to the database directly, sees raw PII |
| **AI model** | Drafts a structured summary from sanitized text inside `<raw_input>` | Has tools, has database access, makes decisions |

## 4. Authentication & authorization boundaries

* **Production:** Supabase Auth issues the JWT. The API verifies it (JWKS or legacy HS256 secret).
* **Local mode:** the API issues its own short-lived JWT for seeded test accounts (password hashes via scrypt in a local-only table).
* For every user request the API opens a transaction, sets `request.jwt.claims` and `SET LOCAL ROLE authenticated` —
  exactly what PostgREST does — so **RLS and `auth.uid()` apply to every query**. Even if a user takes their
  Supabase token straight to PostgREST, the same policies apply.
* Service-only operations (recording AI results, delivery results, PII mappings) live in the `internal`
  schema and are executable only by `service_role`. They are reached only from authenticated n8n callbacks
  or from the API's own orchestration code.
* Roles: `employee`, `manager`, `admin` (one per profile). Managers are scoped to their department.
  Admins manage configuration and see operational metadata, but **RLS does not give admins report
  content, AI drafts or PII mappings**.

## 4b. Who does what

| | Worker (`employee`) | Supervisor (`manager`) | Admin (`admin`) |
|---|---|---|---|
| Submit end-of-shift report | ✔ | | |
| Read and acknowledge incoming handover | ✔ | | |
| Build shift types and the schedule, assign who is on duty | | ✔ own department | |
| **Approve / reject / request revision** | | ✔ own department, not own report | |
| Verify an issue as resolved | | ✔ own department | |
| Accounts, departments, settings, integration health | | | ✔ |

The demo uses one department (Newborn Care Department). More can be added by the admin without code
changes; each gets its own supervisor, schedule and data boundary.

## 5. Shift reporting lifecycle

```
draft ──submit──▶ submitted ──dispatch──▶ processing ──AI ok / AI failed after retries──▶ pending_review
                                                                                            │
         ┌──────────────── revision_requested ◀── request revision ─────────────────────────┤
         │ (employee resubmits → submitted …)                                               ├── reject ──▶ rejected
         └──────────────────────────────────────────────────────────────────────────────── approve ──▶ approved ──deliveries complete──▶ delivered
```

* A shift is a concrete row (`shifts`) generated from a template in the department's time zone.
  `window_opens_at = ends_at − window_open_minutes`, `window_closes_at = ends_at + grace_minutes`.
  Overnight shifts (end time ≤ start time) end on the next calendar day. Time-zone conversion is done by PostgreSQL.
* `app.submit_report()` compares against the database's `now()`; the browser countdown is advisory.
* One report per employee per shift (`unique (shift_id, employee_id)`). Each submission writes an immutable
  `report_revisions` row; drafts live in a mutable column until submitted.
* Late submission requires an unexpired supervisor override (`report_window_overrides`) and is marked `is_late`.
* Resubmission after "revision requested" is allowed outside the window because a supervisor asked for it.

## 6. AI processing & human approval lifecycle (Workflow A)

1. `app.submit_report()` persists the revision and creates an `automation_events` row with an idempotency key `analysis:{report}:{revision}:{attempt}`.
2. The API loads the revision, **sanitizes** it (names → pseudonyms, emails, phones, government IDs, medical terms), runs the deterministic prompt-injection detector, and stores exactly what will be sent plus the reversible name mapping in `internal.analysis_inputs` (service role only, deleted after `pii_retention_days`).
3. The API builds the **six-element bounded prompt** (versioned in `packages/shared/src/prompt`) and dispatches it:
   * `n8n` adapter → authenticated HTTPS POST to the n8n webhook. n8n calls the model with JSON-schema output and posts the result back to `/api/integrations/n8n/analysis-result` with a bearer secret.
   * `dev` adapter → a clearly labeled deterministic simulator (`is_simulated = true`, engine `dev-simulator`). **No AI is called and the UI says so.**
4. The API validates the output with Zod, then runs **grounding checks** against the sanitized source and approved records (evidence quotes present? numbers present? repair claims backed by a maintenance record? "verified" claims downgraded).
5. `internal.record_analysis_result()` stores the run and moves the report to `pending_review`, notifying the department's managers. Invalid output is stored as `invalid_output` and retried; after the retry limit the report still reaches `pending_review` with "AI draft unavailable — review the original" so nothing gets stuck.
6. A manager reviews original vs. draft side-by-side, edits, and explicitly approves / rejects / requests revision via `app.decide_report()`. Nothing is ever auto-approved.

## 7. Delivery & acknowledgment (Workflow B)

* On approval the database records the approved content (immutable), creates in-app `handover_deliveries`
  for every employee assigned to the **next shift** of the same department, creates in-app notifications and
  `notification_deliveries` rows for email, and queues a `handover_delivery` automation event.
* The report becomes `delivered` as soon as the in-app handover deliveries exist (the website is the primary channel; acknowledgment happens there).
* The API dispatches email separately: `n8n` (Resend inside n8n), `resend` (direct), or `dev` (recorded as `simulated` in the dev outbox — never shown as sent). Optional SMS uses its own authenticated n8n webhook and is off by default; with no provider, SMS rows are truthfully marked `skipped`. The `handover_delivery` automation event completes when every external-delivery row is terminal; failures are retried and then raised to administrators.
* If the next shift has no one assigned yet, deliveries are created when someone is assigned.
* Incoming employees acknowledge in the web app. Acknowledgment never changes an issue's status.

## 8. Issue continuity (Workflow C)

* Approving a handover creates `operational_issues` for new unresolved items and `issue_updates` for items linked to existing issue codes.
* Linking uses deterministic issue codes (`ISS-000123`) chosen by the employee or matched by the AI's `related_issue_code` — the manager confirms every link in the review screen; ambiguous matches are never merged automatically.
* An issue absent from a later report stays open. A scheduled tick escalates issues without updates for N hours (configurable) to the department's managers.
* Status machine (enforced in `app.transition_issue()`):

| From | To | Who |
|---|---|---|
| reported | pending_verification, open, closed | manager |
| pending_verification | open, closed | manager |
| open | in_progress, resolution_submitted | employee (dept) or manager |
| open | closed | manager |
| in_progress | open, resolution_submitted | employee (dept) or manager |
| resolution_submitted | resolved | **manager only** (verification) |
| resolution_submitted | in_progress | manager (verification rejected) |
| resolved | closed, open | manager |
| closed | open | manager (reopen) |

## 9. Errors, retries, idempotency, audit

* Every automation event has a unique idempotency key; callbacks are applied at most once (`status` checked under row lock).
* Dispatch failures mark the event `failed` with `next_attempt_at` (exponential backoff); the scheduler retries up to `max_attempts`, then `dead` → admin sees it under Integrations and can retry manually.
* AI timeout: events dispatched longer than `ai_timeout_minutes` ago without a callback are treated as failed.
* Notification deliveries have unique idempotency keys; duplicates are ignored.
* `audit_logs` is append-only (trigger blocks update/delete) and records actor, action, entity and non-sensitive details.
* API errors are mapped to safe messages; database error text is never returned verbatim.

## 10. Privacy & security risks considered

| Risk | Mitigation |
|---|---|
| PII sent to AI provider | Sanitizer + pseudonyms; mapping stored only in `internal` schema; synthetic seed data only |
| Prompt injection inside reports | `<raw_input>` delimiters, explicit instructions, deterministic detector flags, strict output schema, no tools, human approval |
| Hallucinated repairs / quantities | Grounding checks against source and maintenance records; flags shown to reviewer |
| Users bypassing the UI | RLS on every table, writes only via checked functions, server-side window enforcement |
| Admin over-reach | RLS excludes admin from report content, drafts and mappings |
| Replay / duplicate callbacks | Idempotency keys + state checks |
| Secret leakage | Secrets only in server env; the browser receives only the public Supabase anon key |
| Brute force | Rate limiting on login and mutations |
| Notification link abuse | Links point at the app and require sign-in; no tokens in URLs |

## 11. Implementation phases

1. Architecture, schema, RLS, design tokens ✔
2. Auth, roles, departments, shift scheduling ✔
3. Employee portal and report lifecycle ✔
4. Manager review and approval ✔
5. Admin portal ✔
6. n8n integration + dev adapter ✔ (workflows exported; n8n itself **not yet verified live**)
7. Notifications and acknowledgment ✔ (Resend **not yet verified live**)
8. Issue continuity ✔
9. Tests, deployment notes ✔ — see `docs/testing.md` for what was and was not executed.
