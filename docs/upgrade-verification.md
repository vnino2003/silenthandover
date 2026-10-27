# Workplace upgrade verification — 27 October 2026

## Automated verification

`npm test`: **144 tests pass** (8 shared + 136 server/voice). `npm run typecheck` and
`npm run build` pass. After the last task-note change, the 12 assistant integration tests also passed again.
Tests use in-memory PostgreSQL with the actual migrations, RLS policies and workflow functions.
On this Windows sandbox Vitest's default temporary cache could not rename a file; setting `TEMP` and
`TMP` to the repository's ignored `.tmp` directory resolved the environment issue.

Assistant coverage includes authenticated employee-only access, department and author isolation,
service-only preparation storage, missing answers, explicit no-problem/no-task answers,
expiry, version conflicts, oversized input, malformed confirmations, deactivated accounts,
reporting windows, rollback on failure, stale manual drafts, concurrent confirmation,
durable receipts, immutable revisions, downstream analysis/review, incidents, assistance,
task progress notes, completion awaiting verification, sanitized model requests, invalid
model output and provider failures without exposing credentials.

Voice tests exercise the real Vue composable with a browser speech fixture: selected language,
transcript callback, unavailable browser, permission denial, no speech, failed microphone
startup, normal stopping, and abort/handler cleanup on unmount. They do not claim speech-service accuracy.

## Browser checks

Used a separate in-memory synthetic database and web preview; existing local activity was not reset.
Checked employee Today, Assistant, Reports, Issues, Takeover, Profile and Notifications;
supervisor Review, Today, Schedule, Issues, History, Records, Audit and report detail; administrator
Integrations, Users, Departments, Settings, AI Pipeline and Audit at 320, 390, 768 and 1440 CSS pixels.
Measured document width against viewport width and inspected representative screenshots.

Found and corrected a 320-pixel schedule toolbar overflow and long dev-outbox URLs overflowing the
page. Wide tables stay inside their own keyboard-accessible scroll regions. Schedule time fields
use two columns on phones. Inspected the phone confirmation sheet, tablet report detail, desktop
assistant and user directory, mobile tabs and shared loading states.

Completed the text assistant workflow in the browser: report intent → completed work → equipment
problem and supervisor assistance → explicit no pending tasks → editable preparation → confirmation
sheet → receipt → existing report screen showing **Pending Review**. Also checked database-backed
status lookup. Screenshots are in `outputs/workplace-upgrade/`.

## External verification still needed

No live Gemini/Grok model or microphone speech-service session was used. Model contracts and error
handling were verified with controlled provider responses. Real transcription accuracy, microphone
hardware, provider credentials/quota and browser compatibility need validation on the intended
devices. Hosted Supabase, external email/SMS and n8n retain the repository's existing live deployment
checks. Apply the new migration before hosted deployment.

Prepared actions preserve the supervisor gate. Assistance becomes a reviewable department issue;
it does not send a separate external message. A task already in the requested state receives a
progress note; an actual state change uses the existing checked transition function.
