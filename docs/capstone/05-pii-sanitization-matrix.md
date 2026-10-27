# 5. RA 10173 PII Sanitization Matrix

Republic Act No. 10173 (Data Privacy Act of 2012) distinguishes **personal information** from
**sensitive personal information** (which includes health information and government-issued
identifiers such as SSS, TIN and PhilHealth numbers). This design applies the Act's principles of
transparency, legitimate purpose and **proportionality (data minimization)** to the AI step.
It is a technical design, not legal advice — confirm the lawful basis, privacy notice and data-sharing
arrangements with your organisation's Data Protection Officer.

Implementation: `server/src/automation/sanitize.ts`, run on every submission before anything is sent
for analysis. Tests: `server/test/units.test.ts` ("PII sanitization") and `workflow.test.ts`
("removes personal information before anything is sent").

## Matrix

| Data element | Example | Category | Needed by the AI? | Action before AI | Reversible? | Where the original stays |
|---|---|---|---|---|---|---|
| Staff names (department roster) | "Ana Lim", "Ana" | Personal information | No — roles matter, not identity | Replaced by the person's stable pseudonym `[EMP-3F9A1C]`; ambiguous first names become `[EMPLOYEE]` | Yes, for authorized reviewers only | `report_revisions` (RLS: author + dept managers); mapping in `internal.analysis_inputs` |
| Other people's names after an honorific | "Mang Tony", "Kuya Ramon", "Sir Ramos" | Personal information | No | `[PERSON-1]`, `[PERSON-2]` | Yes (same restriction) | As above |
| Email addresses | ana.lim@gmail.com | Personal information | No | `[EMAIL-REDACTED]` | **No** — not kept in the mapping | Original report only |
| Mobile and international phone numbers | 0917 555 0142, +63 917… | Personal information | No | `[PHONE-REDACTED]` | **No** | Original report only |
| Government IDs (SSS, TIN, PhilHealth, Pag-IBIG, UMID, passport, licence) | 34-1234567-8 | **Sensitive** personal information | No | `[GOV-ID-REDACTED]` (formatted patterns and keyword-anchored values) | **No** | Original report only |
| Health information | "has fever", "diabetic", "on sick leave" | **Sensitive** personal information | No | Term replaced by `[MEDICAL-REDACTED]` | **No** | Original report only |
| Operational facts (equipment IDs, PO numbers, quantities, locations) | FL-02, PO 77812, Bay 2 | Not personal | Yes | Kept | — | — |
| Workplace incidents | "slipped near the unit support room" | May relate to a person | Yes (safety) | Kept; any name in it is pseudonymized | — | — |

## Storage, access and retention

| Store | Contents | Who can read | Retention |
|---|---|---|---|
| `report_revisions` | Original words (immutable) | Author, managers of that department | Organisation policy (not auto-deleted) |
| `internal.analysis_inputs` | Exactly what was sent to the AI, the name mapping, redaction counts, injection findings | Service role only; shown to authorized reviewers through the API after an access check | `pii_retention_days` (default 30), then deleted by the scheduled tick |
| `ai_analysis_runs` | Validated draft (pseudonymized) and flags | Department managers | Organisation policy |
| `audit_logs` | Actions and non-content metadata | Admins; managers for their department | Append-only |
| Email | Title and a sign-in link — **no report content** | Recipient | Mail provider |
| Server logs | Event ids, error codes — **no report text** | Operators | Hosting provider |

Administrators cannot read report content, drafts or mappings. The browser shows reviewers
the sanitized text ("Sent to AI" tab) so they can confirm nothing personal left the system.

## AI provider

* Only sanitized text is sent. n8n is configured not to save successful execution data.
* **Disabling model training is not the same as zero data retention.** Providers commonly keep API
  inputs and outputs for a period for abuse monitoring unless a zero-retention arrangement is in place.
  Before processing real workplace data, document the selected provider's current data-processing
  terms, retention period, and processing location, and whether a data processing agreement is needed.
* This repository uses **synthetic demonstration data only**.

## Mica, the assistant

Mica uses the same provider, key and sanitizer as the report analysis, with its own six-element
prompts (`packages/shared/src/mica-prompt.ts`, version `mica-1.0`). Tests: `server/test/mica.test.ts`.

* **Ask answers send only the sanitized question and the page guide.** The records Mica shows
  ("From your records") are read under the user's own permissions and stay in the app.
* **Leave messages and reasons never reach the provider.** Dates are worked out locally; the Leave
  form collects the reason.
* **Prepare** sends the sanitized message, the sanitized draft and non-personal configuration (issue
  codes, the department's report categories). Names come back restored for the author only; text
  the model returns unchanged gets the author's original back, so a detail they typed is not lost.
* A message that looks like a prompt injection is **not sent**; the user is told so.
* Answers are rejected (page guide shown instead) when they contain contact details, links, numbers
  not present in the question or guide, or claims that Mica did something.
* Mica conversations are not stored. A preparation keeps only its editable state, for 24 hours.
* **Voice:** browser speech recognition may send audio to the browser maker's speech service before
  Mica can sanitize anything. The panel says so; typing is always available.

## Known limitations

* Rule-based, not named-entity recognition: a non-staff name without an honorific ("Tony called") is
  not detected. Reviewers can see and check the sanitized text.
* Medical detection uses a term list; unusual wording may pass through.
* Unformatted ID numbers without a keyword (e.g. a bare 12-digit number) are not redacted, to avoid
  destroying quantities and reference numbers.
* Over-redaction is preferred to under-redaction: a roster first name that is also a common word
  ("Grace period") is replaced.
