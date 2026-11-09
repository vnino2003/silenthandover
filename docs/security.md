# Security model

## Layers

1. **Authentication.** Production: Supabase Auth issues the JWT; the API verifies its signature
   (JWKS, or the legacy HS256 secret), issuer and audience. Local mode: the API signs short-lived
   (8 h) HS256 tokens for seeded test accounts; passwords are hashed with scrypt. Login is
   rate-limited (10/min per IP) and returns one generic error for unknown email, wrong password and
   deactivated accounts.
2. **Authorization in the database.** Every request runs in a transaction as the `authenticated`
   role with `request.jwt.claims` set, so `auth.uid()` and Row Level Security apply to every query.
   The same holds if someone bypasses the API and calls Supabase's PostgREST with their token.
3. **Writes only through checked functions.** Users have `SELECT` on tables and nothing else. Every
   change goes through a `security definer` function in the `app` schema that checks the caller's role,
   department and the record's state, with `search_path` pinned.
4. **API validation.** Every body and query string is validated with Zod; IDs are checked; write
   endpoints are rate-limited (120/min per user). Route guards in the browser are for navigation only.

## Who can see what

| Data | Employee | Manager (own dept) | Admin |
|---|---|---|---|
| Own reports and revisions | ✔ | ✔ | ✖ |
| Colleagues' reports | ✖ | ✔ | ✖ |
| AI drafts and flags | ✖ | ✔ | ✖ |
| What was sent to the AI (sanitized) | ✖ | ✔ via API after access check | ✖ |
| Approved handovers delivered to them | ✔ | ✔ | ✖ |
| Department issues | ✔ | ✔ | ✖ |
| Colleagues' names / roles | ✔ | ✔ | ✔ |
| Colleagues' email / phone | ✖ (column privilege) | ✖ | ✔ via `admin_list_users()` |
| Automation events, delivery status | ✖ | own dept events | ✔ (no addresses, no content) |
| Audit log | ✖ | own dept | ✔ |
| Build the schedule, assign who is on duty | ✖ | ✔ own dept only | ✖ |
| Approve reports, verify resolutions | ✖ | ✔ own dept only | ✖ |
| Pseudonym mappings (`internal` schema) | ✖ | ✖ | ✖ — service only |

Administrators set the system up (accounts, departments, settings) but **cannot read report content, approve reports or change the schedule**; the admin overview shows counts.

## Integrity rules enforced by the database

* Submission only inside the window computed from the database clock, or with an unexpired supervisor
  override; late submissions are marked.
* One report per employee per shift; revisions are numbered and immutable.
* Approval only by an active manager of the report's department, not by the report's author, only in
  `pending_review`, and only after every verification flag on the draft has a recorded decision.
* At most one approval per report (unique partial index).
* Issue transitions follow a fixed table; only managers can verify a resolution. Acknowledging a
  handover never changes an issue. An employee's "addressed" claim becomes `resolution_submitted`.
* `report_revisions`, `handover_approvals`, `handover_acknowledgments`, `issue_updates` and
  `audit_logs` reject `UPDATE` and `DELETE` by trigger.

## Integrations

* The browser never calls n8n. The API calls AI, email and optional SMS n8n webhooks with a header secret
  (`N8N_WEBHOOK_SECRET`); production requires HTTPS URLs.
* n8n calls back with a different secret (`N8N_CALLBACK_SECRET`, compared in constant time). Callbacks
  can only report results for work the API dispatched: the event id **and** attempt number must match a
  dispatched event, otherwise the result is ignored. Duplicate callbacks are no-ops.
* n8n posts to a fixed API URL configured inside n8n, not to a URL taken from the payload.
* The AI has no tools and no database access. Its output is untrusted: schema-validated
  (`requires_human_review` must be `true`), grounded against the source, and stored only as a draft.
* Email is idempotent per delivery (provider `Idempotency-Key`) and contains a title and a sign-in link
  only. Links carry no tokens.
* SMS is opt-in per user and disabled system-wide by default. When enabled, the API sends it only to a
  separately configured authenticated n8n webhook; provider credentials remain in n8n.

## Prompt injection

Defence in depth, none of it relying on the model obeying:
`<raw_input>` delimiters with angle brackets in the data neutralized · explicit instructions to treat the
content as data · a deterministic detector whose findings become flags · strict output schema ·
no tools · mandatory human approval of every draft.

## Secrets

All secrets are server-side environment variables (`backend/.env.example`). The browser receives only
the public Supabase URL and anon key. `.env` files are git-ignored. The local JWT secret is generated
per machine under `backend/.data/`.

## Errors and logging

Database errors are mapped to safe messages (`SH:<code>` → HTTP status + user-safe detail); unknown errors
return a generic message with a request id. Logs are structured and never include request bodies or
report text.

## Known limitations

* The in-memory rate limiter is per API instance; use the platform's limiter when running several.
* PII detection is rule-based (see the sanitization matrix) and can miss unusual formats or names
  without an honorific. Reviewers see exactly what was sent to the AI.
* Local mode is for development and demonstration only; `NODE_ENV=production` refuses it.
