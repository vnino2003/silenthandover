# Database

PostgreSQL schema in `supabase/migrations/` (applied in filename order):

| File | Contents |
|---|---|
| `…0100_schema.sql` | Tables, constraints, indexes, immutability triggers |
| `…0200_rls.sql` | Identity helpers, privileges (SELECT only), column grants, RLS policies |
| `…0300_workflow_functions.sql` | Reports, review decision, delivery, acknowledgment, issues, notifications |
| `…0400_admin_internal_functions.sql` | Administrator functions; `internal.*` automation functions and the scheduled tick |
| `…0500_grants_and_defaults.sql` | Function privileges, default settings, email templates |

## Tables

| Area | Tables |
|---|---|
| Organisation | `departments`, `teams`, `profiles` (1:1 with `auth.users`, role, department, stable pseudonym) |
| Scheduling | `shift_templates` (local times + window rules), `shifts` (concrete, timestamptz, window bounds), `shift_assignments`, `report_window_overrides` |
| Reports | `shift_reports` (one per employee per shift, status, mutable draft), `report_revisions` (immutable submissions) |
| AI | `automation_events` (idempotency key, attempts, backoff), `ai_analysis_runs` (prompt version, engine, simulated flag, validated draft, flags, validation errors) |
| Human gate | `handover_approvals` (decision, approved content, per-flag resolutions, reviewer — immutable; one approval per report) |
| Delivery | `handover_deliveries` (approval → incoming employee), `handover_acknowledgments` (immutable) |
| Continuity | `operational_issues` (ISS-codes, status machine), `issue_updates` (immutable history), `issue_assignments`, `operational_records` (maintenance/inventory/dispatch/policy) |
| Notifications | `notifications` (in-app, unique per recipient + event), `notification_deliveries` (email/SMS attempts, provider responses, idempotency key), `notification_templates` |
| System | `app_settings`, `audit_logs` (append-only) |
| Restricted | `internal.analysis_inputs` — sanitized text sent to the AI, reversible name mapping, redaction counts, injection findings; expires after `pii_retention_days` |

Spec table names map as follows: `issue_assignments`, `issue_updates`, `report_revisions`,
`ai_analysis_runs`, `handover_approvals`, `handover_deliveries`, `handover_acknowledgments`,
`notification_deliveries`, `automation_events`, `audit_logs` are as named; `shift_assignments` links
employees to concrete `shifts`.

## Status values

* Report: `draft → submitted → processing → pending_review → (revision_requested → submitted …) | approved → delivered | rejected`
* Issue: `reported`, `pending_verification`, `open`, `in_progress`, `resolution_submitted`, `resolved`, `closed`
* Automation event: `pending`, `dispatched`, `completed`, `failed` (will retry), `dead` (manual)
* Delivery: `pending`, `queued`, `sent`, `failed`, `simulated` (dev outbox), `skipped` (no provider)

## Local mode

`server/src/db/local-shim.sql` recreates what Supabase provides (`auth.users`, `auth.uid()`, the
`anon` / `authenticated` / `service_role` roles) so the same migrations run on embedded PostgreSQL.
The local database is a snapshot file at `server/.data/local-db.tar.gz`; delete it (or run
`npm run seed -- --reset`) to start over.
