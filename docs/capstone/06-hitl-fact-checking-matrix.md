# 6. Human-in-the-Loop Fact-Checking Matrix

Every AI output is a **draft**. Nothing reaches the incoming shift until an authorized supervisor
approves it (`app.decide_report`), and approval is refused while any verification flag lacks a
recorded human decision.

## What is checked automatically, and what the human does

| Claim type | Automated check (server, deterministic) | Flag raised | Source of truth the reviewer compares against | Reviewer decision |
|---|---|---|---|---|
| Any extracted item | Quoted `source_evidence` must appear in the submitted text | Unsupported claim | Original submission (shown side by side; evidence highlighted on click) | Correct, remove, or keep as unverified |
| Quantities | Every number in an item must appear in the source | Conflicting quantity | Original submission; **inventory / dispatch records** | Correct the number, or confirm against the record |
| Repairs / fixes ("fixed", "replaced", "okay na") | Must cite a **maintenance record** reference present in the records list | Unverified repair; item forced to "requires verification" | Maintenance records (Source records panel) | Confirm with record, or keep as unverified, or remove |
| "Supported by record" labels | A provided record's reference must appear in the item | Unsupported claim; label downgraded | Source records | Accept downgrade or confirm |
| Safety concerns | Any safety item is forced to "requires verification" | Safety concern | Site inspection, **approved safety policies** (e.g. POL-SAFE-01) | Confirm it is communicated and controlled |
| Links to existing issues | Code must be an active issue in this department, otherwise removed | Unsupported claim | Open issues list (**task assignment records**) | Confirm the suggested link or create a new issue |
| Responsible people | People named in the draft must appear in the source | Ambiguous assignment | Original submission, shift roster | Remove or correct the owner |
| Embedded instructions | Pattern detector on the raw text | Possible prompt injection | Original submission | Remove the claim / keep as data |
| Personal data in the output | Email/phone patterns in the draft | Privacy redaction | Sanitized input | Edit before approving |
| Missing details | Model lists `missing_information` | Shown as a checklist | Original submission | Request a revision if it matters |
| Model-raised flags | Passed through, labeled "AI model" | Any of the 9 types | — | Same as above |

The model's own verification labels are never trusted on their own; the checks above can only
**downgrade** them.

## Recorded for every approval

Stored immutably in `handover_approvals` and summarized in `audit_logs`:

* the approved content (as edited by the reviewer — this, not the draft, is delivered)
* the reviewer, timestamp, revision number, and the analysis run used
* one decision per flag: *Corrected in summary* · *Confirmed against source record* · *Claim removed* ·
  *Kept, marked unverified* — with an optional note
* the reviewer's verification note
* for each unresolved issue: whether it updates an existing issue or opens a new one, and whether a new
  issue opens as **Open** (confirmed) or **Pending verification** (not yet confirmed)

## Other human gates

| Decision | Who | Enforced by |
|---|---|---|
| Approve / reject / request revision | Manager of the report's department, not the author | `app.decide_report` |
| Mark an issue resolved | Manager only, with a note; employees can only submit for verification | `app.transition_issue` |
| Merge a report item into an existing issue | Reviewer chooses explicitly; AI may only suggest | Review workspace + `app.decide_report` |
| Late submission | Manager grants a time-limited override with a reason | `app.grant_window_override` |
| Acknowledge a handover | Incoming employee; never changes issue status | `app.acknowledge_handover` |

Tests: `workflow.test.ts` (flags required before approval, unauthorized approval, resolution
verification, acknowledgment does not change issues) and `integrations.test.ts` (hallucinated repair).
