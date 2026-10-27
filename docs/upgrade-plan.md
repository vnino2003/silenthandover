# Workplace experience upgrade — 27 October 2026

## Existing system review

The npm workspace has a Vue 3/Pinia/Router/Tailwind client, a Hono API, shared Zod contracts, and 19 PostgreSQL migrations. Local PGlite and hosted PostgreSQL use the same migrations and authenticated transaction context. Existing local files include unfinished UI edits; these must be preserved.

The employee journey is assigned shift → autosaved report → immutable submission → sanitized AI handover draft → supervisor review → incoming crew delivery/acknowledgment. Issues and tasks carry across shifts, support ownership and photo evidence, and require supervisor verification of resolutions. Supervisors also manage shift patterns, assignment, overrides and source records. Administrators manage accounts, departments, provider keys, operational integrations and notification settings. Notifications, profile photos, audit history, retry queues and optional n8n/email/SMS are already implemented.

Authentication is verified in the API; active profiles and roles are checked before routes execute. User queries run with RLS. Checked SQL functions enforce reporting windows, department membership, state transitions and human review. AI output never approves a handover. Gemini/Grok credentials are encrypted server-side. The development analyzer is explicitly simulated. Hosted services have not been verified live.

## Findings and implementation sequence

1. Keep existing URLs, workflow functions and permissions. Refresh shared design tokens, shell, page headers, controls, empty states and surfaces so all portals benefit. Remove the custom pointer; add visible navigation icons, role-specific mobile tabs, safe-area spacing, usable touch targets and constrained table scrolling. Preserve schedule tables where horizontal comparison is useful.
2. Add an employee assistant route. Reuse administrator-connected Gemini/Grok through the existing provider adapter. With no provider, offer explicitly labeled guided data gathering, not a pretend model. Voice uses browser speech recognition, with editable transcripts and text fallback.
3. Prepare reports, incidents, assistance requests and existing task updates using shared schemas. Gather missing fields; never interpret silence as no problems/no tasks. Present an editable summary before the employee explicitly confirms. Status responses are database reads, not model-generated facts.
4. Persist short-lived proposals on the server, with ownership, version checks, expiry and exactly-once confirmation under row lock. Route mutations through existing checked SQL functions in the authenticated context. Validate model output, sanitize outbound text, constrain issue references to the employee's department, reject stale report drafts and retain content-free action audits.
5. Run baseline and regression tests, add database-backed assistant/security/error cases, typecheck and production builds. Inspect desktop, tablet and mobile views in a browser. Record actual verification and external-service limitations.

## Integration boundaries

Assistance requests create reviewable operational issues using the existing supervisor queue; they do not send messages outside the configured application workflow. Task completion is a resolution claim awaiting supervisor verification. The assistant cannot approve reports, verify repairs, change schedules, manage accounts or access another employee's reports. Provider failures leave the current proposal intact and allow retry. Conversational proposals expire after 24 hours; transcripts are not kept in browser storage.
