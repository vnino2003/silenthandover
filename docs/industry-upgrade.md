# Industry-independent experience and newborn-care demo

Review: permissions, handover approval, assignment, carry-over issues, evidence, schedules and report states already work across industries. Preserve these and the Employee page structure. Replace warehouse-specific examples and defaults; broaden record and concern categories. Keep stable legacy category identifiers for older reports.

Department configuration will own organization name, industry context, staff/reviewer/report/issue terms, report guidance, privacy guidance, available concern categories and source-record types. Existing schedule controls own working days, patterns and reporting windows; human approval and authorization remain mandatory.

The synthetic Starlight Community Hospital demo uses the Newborn Care Department, 24-hour coverage, operational equipment checks, unit readiness, supplies, staffing and facilities follow-ups. It contains no actual patients, diagnoses or treatment instructions. Ordinary sample reports are separated from adversarial regression fixtures.

NatsGo reference reviewed: `capstone/natsgo_vue/frontend/src/components/shared/nori/NoriAssistant.vue`. Adopt its persistent compact entry point and page context without copying Nori's identity or transportation logic. Mica, an original teal messenger bird, appears in the launcher, welcome state, message avatar and restrained loading state. The assistant stays closed until requested, retains a preparation across navigation, and never reads arbitrary page contents or gains extra permissions.

## Implemented configuration

Administrators use Departments → Customize. Settings are validated with the shared DepartmentExperience schema, persisted through an administrator-only checked database function, read under RLS, and applied to role/navigation labels, report prompts, concern choices, source-record choices and assistant context. New departments default to generic language. Existing category and record identifiers remain supported for older data. The neutral `extended_hours` schedule preset preserves compatibility with older callers.

The Employee structure is unchanged. The mobile assistant tab was removed from primary navigation; the floating entry is available to every role. A full employee assistant workspace remains available. Preparation edits and confirmation use the existing server snapshot and workflow functions. Page help is available to supervisors and administrators, with server-side role checks; it never executes actions or automatically sends the current page body to a provider.

## Installed local demo and preservation

The previous local database had custom accounts, so no original accounts or activity were deleted. The active demo was installed separately at `server/.data/newborn-care-demo`; `server/.env` now selects that directory. The previous snapshot remains at `server/.data/local-db.tar.gz`. To reopen it, stop the local API, restore LOCAL_DB_DIR to the original `server/.data` directory, and restart. The demo migration script carries forward an encrypted provider configuration if one exists; the previous database in this run had no connected provider.

The hospital presentation has seven synthetic accounts, Day/Evening/Night patterns, named night coverage, equipment/readiness/staffing/policy source records, two tracked operational concerns and a prepared unit handover. A relative-time demonstration shift keeps a reporting window available. Operational examples are separate from the adversarial regression report. Demo names, accounts, source records and examples contain no warehouse content.

## Verification

150 automated tests pass (8 shared + 142 server/voice), including configuration permissions and validation, role-specific contextual help, author-scoped preparations, the real hospital presentation seed, 24-hour patterns, named night coverage, draft contents, existing handover/approval/delivery/continuity, duplicate protection and voice error handling. TypeScript and production builds pass.

Browser checks covered employee, supervisor and administrator screens at 320, 390, 768 and 1440 CSS pixels. Inspected the floating panel, hospital draft review, phone confirmation sheet, 24-hour schedule, source records and customization form. Verified that an open preparation survives in-app navigation from Today to Reports while the page context changes. No document overflow or warehouse text was found in the checked rendered pages. Screenshots and width measurements are in `outputs/industry-upgrade/`.

Live provider calls and actual microphone transcription were not used. The app explicitly labels guided mode. Existing live-integration deployment checks still apply. Apply `20261027000200_department_experience.sql` before hosted deployment; this run updated the local demo only.

## Mascot provenance

Mica was generated with the built-in image_gen tool and saved to `apps/web/public/assistant/mica.png`. The exact prompt and usage notes are in the adjacent README. Its identity is independent of any industry. No employee or patient data was used to generate the image.
