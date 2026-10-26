# Testing

Run everything with:

```bash
npm test
```

**Last recorded run: 26 Oct 2026 — 89 automated tests, 89 passed** (server 81, shared 8), plus
TypeScript checks (`npm run typecheck`) and production builds (`npm run build`) passing.

## How the tests work

* Server tests run the **real SQL migrations, RLS policies and workflow functions** on embedded
  PostgreSQL 17 (PGlite) in memory, seed the synthetic demo data, and call the real HTTP API.
  Each request runs as the `authenticated` role with the user's id in `request.jwt.claims`, the same
  way PostgREST does on Supabase.
* n8n, OpenAI and Resend are **simulated with a fake `fetch`** that records requests and returns chosen
  responses. This verifies the API side of every contract (payload, secrets, idempotency, callbacks,
  retries). It does **not** prove that the n8n workflows or the model behave correctly — see "Pending".
* AI drafts in the end-to-end tests come from the **development simulator**, which is clearly labeled
  and is not an AI model.

## Required cases

Status key: **Pass** = automated test passing · **Browser** = also verified by hand in the running app ·
**Pending** = needs a live external service, not yet run.

| Required case | Where | Status |
|---|---|---|
| Employee login | workflow › logs an employee in; rejects a wrong password with a generic message | Pass, Browser |
| Unauthorized role access | workflow › blocks employees from manager and admin endpoints; requires a session; keeps managers out of other departments | Pass |
| Correct shift assignment | workflow › shows the assigned shift with an open reporting window; refuses employees who are not assigned; refuses a reassigned employee; lets the supervisor, and only the supervisor, manage the schedule | Pass, Browser |
| Reporting window not yet open | windows › refuses to open a report before the shift starts; allows an early draft but not an early final submission | Pass |
| Reporting window active | workflow › accepts the final submission | Pass, Browser |
| Reporting window expired | windows › closes the window after the grace period; a supervisor override allows a late submission (marked late) | Pass |
| Overnight shift | windows › generates overnight shifts that end the next local day; handles daylight-saving time zones | Pass |
| Duplicate report submission | workflow › creates one draft per employee and shift; accepts the final submission and refuses a duplicate | Pass |
| Missing required fields | workflow › rejects a submission with missing required fields; shared › requires an explicit "none" instead of silence | Pass |
| n8n webhook failure | failure handling › records webhook failures and falls back to manual review after the retry limit | Pass (simulated n8n) |
| AI timeout | failure handling › treats a missing AI result as a timeout and retries | Pass |
| Invalid AI JSON | Workflow A › rejects malformed JSON from the model and schedules a retry | Pass |
| Prompt injection attempt | workflow › flags the injection attempt…; did not obey the embedded instruction; Workflow A › rejects schema-valid JSON that tries to skip human review; units › injection detector cases | Pass, Browser |
| PII sanitization | workflow › removes personal information before anything is sent; Workflow A › sends only the sanitized, bounded prompt to n8n; units › PII sanitization | Pass, Browser |
| Hallucinated repair claim | Workflow A › accepts valid output, runs grounding checks, and flags a hallucinated repair | Pass |
| Supervisor rejection | revision and rejection › … then the manager rejects | Pass |
| Supervisor approval | workflow › refuses approval until every verification flag has a decision; approves the reviewed handover and delivers it | Pass, Browser |
| Unauthorized approval attempt | workflow › refuses approval by an employee, even via the database function directly; keeps managers out of other departments | Pass |
| Duplicate delivery event | workflow › delivering the same approval again creates nothing new; cannot approve the same report twice; Workflow B › accepts each result once | Pass |
| Email provider failure | Workflow B › records provider failures, retries, and alerts administrators | Pass (simulated Resend) |
| Incoming acknowledgment | workflow › lets incoming staff read and acknowledge the approved handover — once | Pass, Browser |
| Unresolved issue persistence | workflow › keeps unresolved issues open for the next shift; continuity › escalates stale issues once | Pass, Browser |
| Resolution verification | workflow › requires an authorized person to verify a resolution; rejects transitions the state machine does not allow; checklist › counts as done only after the supervisor confirms it | Pass, Browser |
| Next-shift checklist and photo proof | checklist › requires an answer about open problems, and accepts them one at a time; turns every task for the next shift into a tracked checklist item; shows the incoming worker a checklist with live status; lets the worker mark a task done with a photo, which only their department can see; rejects photos that are not images | Pass, Browser |

Additional checks: immutable revisions and audit log, admin cannot read report content, column-level
privacy for colleagues' contact details, incoming staff cannot read raw reports, SMS never reported as
sent without a provider, optional SMS n8n dispatch and callback idempotency, database and UI issue-transition tables match, delimiter escaping in the prompt, provider-ready
JSON schema, missing-report alerts.

## Manual verification in the browser (26 Oct 2026, local mode)

Signed in as each demo role and walked through: employee dashboard with live window countdown →
report form with autosave → submit → manager queue (flag count, safety tag, "Simulated") → review
workspace (original vs. draft, sanitized view, flags with evidence highlighting, suggested issue links)
→ approve with every flag decided → incoming employee sees only the approved handover and acknowledges
it → issue statuses unchanged → admin Integrations page shows simulator, dev outbox (masked addresses,
no report content in email), event history. Checked the mobile layout at 375 px (no horizontal scroll).

## Pending — not yet run

| Item | Why pending | How to run |
|---|---|---|
| n8n Workflows A, B, C executing for real | No n8n instance connected in this repository | `n8n/README.md` §5 |
| Live model behaviour on the six-element prompt (v1.0 and v1.1) | Needs an API key | `npm run prompt:eval -- --version 1.0` (and `1.1`) |
| Resend delivering real email | Needs a Resend account and verified domain | `EMAIL_TRANSPORT=resend` or Workflow B |
| SMS provider delivery through n8n | Needs an SMS provider account and a provider-specific n8n workflow | Set `SMS_TRANSPORT=n8n` and follow `n8n/README.md` |
| Supabase mode (Supabase Auth JWT verification, pooled Postgres, admin user creation) | No Supabase project connected | `docs/deployment.md` |
| Load / concurrency testing | Out of scope for the prototype | — |
| Screen-reader audit | Only basic checks done (labels, focus trap in dialogs, focus-visible styles) | — |

The prompt harness itself was exercised in `--simulator` mode to confirm it runs and writes nothing
misleading; simulator output is **not** a prompt evaluation and was not kept.
