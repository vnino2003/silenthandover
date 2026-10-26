# 1. Three-Criterion Automation Audit

**Task audited:** turning each employee's end-of-shift notes into a verified handover for the next
shift, and keeping unresolved issues visible until someone authorized confirms they are fixed.

## Criterion 1 — High frequency ✔

* Happens at **every shift change, for every employee**. A site running three 8-hour shifts produces a
  report per person, three times a day, every day.
* Illustrative volume (an assumption for planning, not measured data): a warehouse with 10 people per
  shift → 30 reports/day → about 900 per month for one department.
* Each manual handover costs the outgoing employee time to write, the supervisor time to read and
  chase, and the incoming employee time to find what matters. The cost repeats every shift.

## Criterion 2 — Rule-bounded ✔

The process follows explicit, checkable rules, which is what lets software enforce it:

| Rule | Where it is enforced |
|---|---|
| Report only during a fixed window (e.g. 30 min before shift end to 30 min after) | `app.window_state()`, `app.submit_report()` — database clock |
| One report per employee per shift; changes only through a requested revision | unique constraint + status checks |
| Fixed report sections; "none" must be stated explicitly | `ReportSubmission` schema |
| Only a supervisor of that department may approve; never their own report | `app.decide_report()` |
| Every verification flag needs a recorded decision before approval | `app.decide_report()` |
| Issue status follows a fixed transition table; only supervisors verify resolution | `app.transition_issue()` |
| Handover goes to the next shift of the same department/team | `app.next_shift()` |

The AI's part is also bounded: a fixed role, fixed output schema, no tools, and no authority.

## Criterion 3 — Digital ingestion ✔

* Input is captured digitally at the source: a web form (mobile-first) with structured sections,
  saved as JSON in PostgreSQL.
* Every downstream step consumes that digital record: sanitization, AI drafting, review, delivery,
  issue tracking and audit. No paper, no re-typing, no scanning.

## Verdict

All three criteria are met, so the task is a good candidate for automation **with a human approval
gate**, because the content is safety-relevant and written in free text:

| Automate | Keep human |
|---|---|
| Window enforcement, reminders, missing-report alerts | Deciding whether a claim is true |
| Removing personal data before AI use | Approving, correcting or rejecting the handover |
| Drafting a structured summary and flagging gaps | Merging a report item into an existing issue |
| Checking quotes and numbers against the source | Declaring an issue or hazard resolved |
| Delivery, acknowledgment tracking, escalation | Granting late-submission overrides |
