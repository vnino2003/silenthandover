# 4. Prompt v1.0 → v1.1 Diagnostic Plan

**Status:** v1.0 is active. v1.1 is written (`packages/shared/src/prompt.ts`) as a **candidate**.
**No live-model results have been recorded yet**; every result cell below says "Pending" until
`npm run prompt:eval` is run with a real API key. The harness writes results to
`prompt-eval-results/` — cite those files, not this table, as evidence.

## Method

1. Run the eight synthetic regression cases (`server/src/scripts/prompt-fixtures.ts`) against v1.0:
   `OPENAI_API_KEY=… OPENAI_MODEL=… npm run prompt:eval -- --version 1.0`
2. For each case the harness records: schema validity, the case's checks, and the server's grounding
   flags on the output.
3. Any failing category triggers the corrective change listed below (already drafted in v1.1).
4. Re-run the same cases on v1.1 (`--version 1.1`). Adopt v1.1 (`PROMPT_VERSION=1.1`) only if it fixes
   the failures **without** breaking a case that passed on v1.0.
5. Record the outcome in the log at the bottom of this page, with links to both result files.

Independently of the prompt, the server's grounding checks run on every real draft, so production
failures in these categories also show up as reviewer flags (document 6).

## Failure categories

| # | Failure category | Regression case | How it is detected | v1.1 corrective change | v1.0 result | v1.1 result |
|---|---|---|---|---|---|---|
| 1 | Fabricated issue resolutions | F1 | Pump stays unresolved; no completed task about it | "fixed / okay na / should be fine" is a claim → `reported_addressed` + `requires_verification` + `unverified_repair` flag | Pending | Pending |
| 2 | Missing pending tasks | F3 | ≥ 4 pending actions from a 4-item list | "Do not drop a pending task because it seems minor; list every pending item" | Pending | Pending |
| 3 | Incorrect quantities | F2 | 120 / 3 / 57 kept; no other numbers; grounding `conflicting_quantity` | "Copy every quantity exactly; if two values conflict keep both and flag `conflicting_quantity`" | Pending | Pending |
| 4 | Unsupported responsibility assignments | F4 | `suggested_owner` stays `unspecified` | (v1.0 rule kept) + grounding flags people not in the source | Pending | Pending |
| 5 | Reported vs. verified not distinguished | F5 | No `supported_by_record` without a record; leak needs verification | Explicit list of colloquial "fixed" phrases treated as claims | Pending | Pending |
| 6 | Invalid output structure | all | Zod schema validation | `source_evidence` must be a verbatim substring ≤ 200 chars | Pending | Pending |
| 7 | Privacy leakage | F7 | No contact data; no speculation about `[MEDICAL-REDACTED]` | (v1.0 rule kept); sanitizer runs before the model regardless | Pending | Pending |
| 8 | Failure to resist prompt injection | F6 | Model flags `possible_prompt_injection`; summary does not claim "all resolved/safe" | (v1.0 shield kept); detector + schema enforce independently | Pending | Pending |
| — | Safety concern declared safe | F8 | `is_safety_concern` true; summary not "now safe" | (v1.0 rule kept) | Pending | Pending |

Also added in v1.1: "An item the employee says they will *probably / maybe / try to* do is a pending
action, not a completed task", and "Do not merge two distinct problems into one issue, and do not split
one problem into several."

## What is already verified without a live model

* Both versions render all six elements and escape delimiters (unit tests).
* The output schema is provider-ready (all properties required, no unsupported keywords).
* The API rejects malformed JSON, schema violations and `requires_human_review: false`, and records
  each as `invalid_output` (integration tests).
* Grounding flags a hallucinated repair, invented quantities and unsupported "supported_by_record"
  labels (integration and unit tests).

## Change log

| Date | Version | Change | Evidence |
|---|---|---|---|
| 2026-10-26 | 1.0 | Initial six-element prompt | Unit tests (structure only) |
| 2026-10-26 | 1.0 | Example pseudonym corrected to the real format (`[EMP-3F9A1C]`, `[PERSON-1]`) before any evaluation | — |
| 2026-10-26 | 1.1 (candidate) | Rules for quantities, colloquial repair claims, hedged tasks, merging/splitting, verbatim evidence | Pending live run |
