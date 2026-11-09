# Plan: architecture, Android, Attendance, DTR and Payroll (for approval)

Status: **proposal, Phase 0 (read-only audit)**, 9 November 2026. No code has been changed for this
plan. Nothing below is implemented until each phase is approved.

Legend: **Confirmed** = read in the current working copy. **Doc claim** = stated in docs, not
re-verified. **Unverified** = cannot be checked from this machine.

---

## 1. What exists today (verified against the working copy)

### 1.1 Repository and stack

```
tesda_capstone/                     (npm workspace "silent-handover", Node >= 20.12)
├── apps/web/          Vue 3.5, Ionic Vue 8.8.19, Vite 8, Pinia, Tailwind 4 (layout only), TS 5.9
│   ├── vercel.json    Vercel build: cd ../.. && npm ci && npm run build -w apps/web
│   ├── Dockerfile     nginx image for a VPS (untracked, new)
│   └── nginx.conf     (untracked, new)
├── server/            Node, Hono 4, TypeScript, tsup build, vitest
│   ├── Dockerfile     API image, built from the repository root
│   └── src/{auth,automation,db,http,routes,scripts,security,seed}
├── packages/shared/   Zod contracts, prompts, labels, department wording
├── supabase/migrations/   30 SQL files: schema, RLS, app.* security-definer workflow functions
├── n8n/               docker-compose and workflows (optional integration)
├── docs/, outputs/ (presentation and video artifacts, mostly untracked), work/, .tmp/
├── render.yaml        Render blueprint for the API (untracked, new)
├── .dockerignore      (untracked, new)
└── package.json, package-lock.json, tsconfig.base.json
```

**Confirmed differences from the brief:**

| Item | Brief | Working copy |
|---|---|---|
| `.github/workflows/` | expected | **does not exist**, no CI at all |
| Git remote | GitHub implied | **no remote configured**: nothing has been pushed |
| Deployment | "preserve the current deployment" | `docs/deployment.md` says the repository **has not yet been deployed** to Vercel/Render/Supabase. The only running system is local (PGlite) |
| Uncommitted work | — | **118 changed or new paths** on `master` from three sessions (Ionic migration, hospital wording, invitations/email sender/forgot-password/go-live, presentation outputs). This must be committed before a folder move |
| Migration runner | version-based | `server/src/db/migrate.ts` records the **full filename** in `public.schema_migrations`, so the two `20261104000100_*` files both apply. The collision matters only if the Supabase CLI (`supabase db push`, version-based) is ever used. It is **not** used today |

**Active deployment paths:**

- **Confirmed:** local `npm run dev`, with PGlite in `server/.data/<dir>` and local JWT auth. `server/.env` currently selects the `live` database.
- **Unverified:** Vercel (web), Render Docker (API), Supabase (Postgres and auth). These are configured in files only.
- **Unverified:** a VPS nginx image. Its Dockerfile exists but was never built here.

**Environment variable names** (values not read):

- **API (`server/src/config.ts`):**
  - Runtime and mode: NODE_ENV, PORT, APP_BASE_URL, PUBLIC_API_URL, CORS_ORIGINS, APP_MODE, MIGRATE_ON_START, DEMO_MODE
  - Local database: LOCAL_DB_DIR, LOCAL_JWT_SECRET
  - Supabase: DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET
  - AI and Mica: AI_ADAPTER, AI_REQUEST_TIMEOUT_MS, MICA_REQUESTS_PER_MINUTE, SECRETS_ENCRYPTION_KEY, PROMPT_VERSION, DEV_ANALYSIS_DELAY_MS
  - n8n: N8N_ANALYSIS_WEBHOOK_URL, N8N_DELIVERY_WEBHOOK_URL, N8N_WEBHOOK_SECRET, N8N_CALLBACK_SECRET, N8N_REQUEST_TIMEOUT_MS, N8N_SMS_WEBHOOK_URL
  - Email and SMS: EMAIL_TRANSPORT, GMAIL_USER, GMAIL_APP_PASSWORD, RESEND_API_KEY, EMAIL_FROM, SMS_TRANSPORT, SMS_FROM
  - First start and scheduler: FIRST_ADMIN_EMAIL, FIRST_ADMIN_NAME, ENABLE_INTERNAL_SCHEDULER, SCHEDULER_INTERVAL_MS
- **Web:** only `VITE_API_URL`. In development Vite proxies `/api`.
- **Gap:** `server/.env.example` lists about half of the API names. Phase 1 completes it.

### 1.2 Existing features (regression baseline)

| Area | Confirmed behaviour |
|---|---|
| Accounts | Base roles `employee`, `manager`, `admin` (DB check constraint). Department titles (Head Nurse) come from `departments.experience`, separate from permissions. Invitations, set-password, forgot-password (new, uncommitted), first-admin bootstrap, profile with photo, notifications, audit log |
| Duty scheduling | Shift templates/patterns, assignments (soft-removed with `removed_at/removed_by`, so history is kept), overnight shifts, ad hoc shifts, minimum staffing, coverage conflicts, rest days/day marks |
| Leave | Request → impact preview → decide → cancel. Approval soft-removes affected assignments. Admin has no access (UI, API and DB, commit 52c4c7a) |
| Shift endorsements | Draft → submit (window/override) → Mica analysis (sanitised, versioned prompt) → Head Nurse review with flags → approve → delivery and acknowledgement. Also concerns, task takeover, unit records and resolution verification |
| Mica | Role-aware help, preparation drafts with human confirmation, local facts, provider settings, organisation rules |
| Integrations | Gmail/Resend email (Gmail configurable in the admin page), SMS and n8n marked "coming soon" unless configured |
| Tests | 195 server tests (12 files) passed on 4 Nov. Shared tests; web typecheck and build pass |

### 1.3 Previously reported gaps: status

| Gap | Status | Evidence |
|---|---|---|
| Unit board "on duty" comes from the roster, not presence | **Confirmed** | `server/src/routes/leave.ts:219-223`: `onNow` = an assigned shift whose time window contains now |
| Leave impact keyed on the shift's start date | **Confirmed** | `20261027000300_scheduling_and_leave.sql:206,246,520,534`: `s.shift_date between start_date and end_date`. A Night shift that starts the day before leave is not counted, even though it runs into the leave day |
| No-approver path notifies admins with obsolete `/admin/leave` | **Confirmed** | same migration, line 179. The admin has no leave page (commit 52c4c7a), so the link is dead and the admin can't act on it |
| Duplicate migration prefix `20261104000100` | **Confirmed, low risk** | Safe with the in-app runner (full filename). Rename only together with a `schema_migrations` row update, or leave it and document it |

Additional findings:

- Server tests import frontend code (`server/test/mica-*.test.ts`, `voice.test.ts`, `server/tsconfig.json` and `vitest.config.ts` path `../apps/web/src`). These break on a folder move unless updated.
- Nothing stores actual presence, replacements (who covered whom) or time worked. Schedules are plans only. This is the foundation Attendance needs.

---

## 2. Target structure (Phase 1)

```
silent-handover/
├── frontend/          ← apps/web   (Vue/Ionic; Capacitor android/ added in Phase 2)
├── backend/           ← server     (Hono API, jobs, scripts, tests)
├── packages/shared/   unchanged
├── supabase/migrations/   unchanged path (the runner looks for ../../supabase/migrations; depth stays the same)
├── n8n/, docs/        unchanged
├── outputs/           kept, outside every build context (.dockerignore already excludes it)
├── .github/workflows/ ci.yml (Phase 1), android-apk.yml (Phase 2)
├── package.json, package-lock.json, tsconfig.base.json, render.yaml
```

Workspace names stay `@sh/server`, `@sh/web` and `@sh/shared` (or are renamed in the same commit), so `-w` commands change in one place.

### 2.1 Path-by-path impact of the move

| File | Change |
|---|---|
| `package.json` | workspaces `frontend`, `backend`; scripts `-w backend`, `-w frontend` |
| `package-lock.json` | regenerated with `npm install`, then `npm ci` must pass |
| `server/Dockerfile` → `backend/Dockerfile` | all `COPY server/…`, `apps/web/package.json`, `server/dist/main.js` |
| `apps/web/Dockerfile` → `frontend/Dockerfile` | `COPY apps/web …`, `apps/web/nginx.conf`, `apps/web/dist` |
| `render.yaml` | `dockerfilePath: ./backend/Dockerfile` (context stays `.`) |
| `apps/web/vercel.json` → `frontend/vercel.json` | `npm run build -w frontend`; Vercel **Root Directory** = `frontend` (a project setting, documented) |
| `server/tsconfig.json`, `server/vitest.config.ts` | `@/*` → `../frontend/src/*` |
| `server/test/mica-experience`, `mica-session`, `voice` tests | `../../frontend/src/...` |
| `.claude/launch.json` | `-w frontend` |
| `server/src/main.ts`, `scripts/migrate.ts`, `go-live.ts` | comments and messages say `backend/.env` |
| `server/.data/` (local databases) | moves with the folder; `LOCAL_DB_DIR` is relative, so it keeps working. **Back up first** |
| `.gitignore`, `.dockerignore` | `server/.env` and `server/.data` → `backend/...` |
| Docs (README, deployment, architecture, testing, presentation guide) | paths updated |

Unchanged by the move:
- API URLs (`/api/...`), auth callbacks, invitation and reset links (built from `APP_BASE_URL` plus `/set-password?...`)
- Migration history and data

The move is done with `git mv`, so file history is kept.

### 2.2 Code organisation after the move (only where it helps)

- **Frontend:**
  - Keep `pages/`, `components/ui/`, `stores/`, `lib/`.
  - Split `lib/` into `api/` (client and types), `composables/` and `utils/`, and add a `layouts/` folder for `AppShell`.
  - No new state library.
- **Backend:**
  - Keep `routes/` (HTTP parsing and role checks).
  - Move the long query and board builders (e.g. `boardFor`, `employeeSchedule` in `routes/leave.ts`) to `services/`.
  - Workflow rules stay in the SQL `app.*` functions.

---

## 3. Roles and permissions

### 3.1 Approach

Keep the three base roles (they drive RLS everywhere). Add **scoped capabilities** in a new table, `role_grants(profile_id, capability, department_id null = all, granted_by, valid_from, valid_to)`. They are checked by `app.has_capability(cap, dept)` in SQL, the same check in the API, and route `meta` in the UI.

| Capability | Typical holder | Scope |
|---|---|---|
| (manager role) | Head Nurse / Department Supervisor | own department |
| `nursing_service` | Chief Nurse / Nursing Service Office | several or all nursing units: cross-unit cover, escalations, delegated approvals |
| `timekeeper` | HR timekeeper | departments assigned |
| `payroll_preparer` | Payroll personnel | pay groups assigned |
| `finance_approver` | Finance / Accounting | pay groups assigned; **never the preparer of the same run** |
| `hr_admin` | HR head | compensation settings, policies |
| (admin role) | IT | accounts and system settings; **no** workforce or financial data |

Rules enforced in the database:
- No self-approval: a person can't verify, certify or approve their own DTR, leave, overtime or payroll line.
- The preparer is not the approver, enforced in the `app.approve_payroll_run` function.
- Managers who also work duty use their own **My attendance** and **My DTR** like staff. Their certification goes to Nursing Service.

### 3.2 Permission matrix (target)

| Action | Staff | Head Nurse | Nursing Service | Timekeeper | Payroll | Finance | IT admin |
|---|---|---|---|---|---|---|---|
| View own schedule, attendance, DTR, payslip | ✓ | ✓ (own) | ✓ (own) | own | own | own | own |
| QR time-in/out | ✓ | ✓ | ✓ | — | — | — | — |
| Fallback attestation for someone | — | ✓ unit | ✓ scope | — | — | — | — |
| Resolve exceptions, approve corrections | request | ✓ unit (not self) | ✓ scope | ✓ reconcile | — | — | — |
| Certify unit DTR for a period | — | ✓ | ✓ escalated | — | — | — | — |
| Lock period, HR reconciliation | — | — | — | ✓ | — | — | — |
| Prepare payroll run | — | — | — | — | ✓ | — | — |
| Approve and release payroll | — | — | — | — | — | ✓ (≠ preparer) | — |
| See leave reasons | own | ✓ unit | ✓ scope | type only | **never** | **never** | never |
| See raw device evidence | own | unit summary | scope summary | ✓ | **never** | never | device health only |
| Manage accounts and devices | — | — | — | — | — | — | ✓ |

---

## 4. End-to-end workflows (target)

1. **Plan:** Head Nurse rosters (existing). Each assignment change writes a new **duty expectation version** with its effective time.
2. **Attend:**
   - Staff scan the rotating QR at the unit station while signed in. That records an **attendance event** (append-only).
   - Fallback: the Head Nurse attests the person was present, with a reason.
3. **Reconcile** (automatic, re-runnable): events are matched to the assignment, giving **work intervals** and **exceptions** (missing punch, late, undertime, unscheduled, duplicate, possible absence). Approved leave excuses the covered interval; pending leave becomes a review item.
4. **Correct:** Staff request a correction. The Head Nurse approves it (never their own). The original evidence is kept and the correction references it.
5. **Overtime:** Early or late work creates a candidate. Authorisation, verified time, and payable-versus-compensatory treatment are separate steps.
6. **Certify:** Staff confirm their DTR (honor statement). The Head Nurse verifies and certifies the unit for the cutoff, producing a DTR version. A Form 48-compatible PDF is available where applicable.
7. **HR:** The timekeeper reconciles, resolves leftovers and **locks the period**. Later changes become adjustments in the next period.
8. **Payroll:**
   - The preparer builds a run from **certified quantities only** plus the versioned policy.
   - Finance approves; this must be a different person.
   - The release or export is authorised, then staff see their payslip.

States shown separately on the unit board: **scheduled**, **clocked in**, **verified present**, **confirmed absent**. This fixes the "on duty from roster" gap.

---

## 5. Proposed data model and API (Phases 3–5)

All tables follow the existing patterns:
- RLS for reads
- writes only through `security definer app.*` functions that call `app.fail`
- `app.audit` for every change
- `app.notify` for alerts

| Entity | Purpose | Key columns |
|---|---|---|
| `duty_expectations` | versioned planned duty per assignment | assignment_id, version, expected_start/end, effective_from, superseded_at, reason, changed_by |
| `attendance_devices` | registered stations or terminals | department_id, kind (qr_station, kiosk, biometric_gateway), secret ref, last_seen, clock_drift_ms |
| `attendance_events` | append-only punches | id, event_key **unique** (idempotency), profile_id, kind (in/out), source (qr, attestation, kiosk, biometric), device_id, captured_at, received_at, evidence jsonb (no biometrics), attested_by |
| `attendance_qr_tokens` | rotating codes | device_id, nonce hash, valid_from/to (e.g. 30 s), used_count |
| `work_intervals` | reconciled worked time | assignment_id, profile_id, start/end, minutes, split parts (midnight, holiday, cutoff), status (provisional/verified) |
| `attendance_exceptions` | review queue | kind, assignment_id, profile_id, state, resolved_by, resolution |
| `attendance_corrections` | authorised changes | exception_id, requested_by, approved_by (≠ subject), before/after, reason |
| `coverage_changes` | replacements and swaps | original_assignment_id, replacement_assignment_id, authorised_by, authorised_at, emergency, retrospective |
| `overtime_requests` | authority, verification, treatment | assignment_id, requested/authorised_by, verified_minutes, treatment (pay, CTO) |
| `pay_policies` | versioned rules | pay_group, effective_from, rules jsonb, approved_by |
| `pay_groups`, `cutoff_periods` | calendar | group, start/end, pay date, state (open → certified → locked) |
| `dtr_versions` | certified totals per person and period | profile_id, period_id, version, totals jsonb, source refs, staff_signed_at, certified_by, locked_at |
| `payroll_runs`, `payroll_lines`, `payroll_adjustments` | drafts and approvals | run state, prepared_by, approved_by, lines (earning/deduction code, quantity, rate, amount, source dtr_version) |
| `compensation_settings` | effective-dated pay data (restricted) | profile_id, basic rate, effective_from |

**Concurrency:**
- Reconciliation takes an advisory lock per (department, period).
- Roster and leave functions bump a department `roster_version`. Reconciliation records the version it used and re-runs if it changed.

**API sketch** (Hono routes, each calling one `app.*` function):

- **Staff:**
  - `POST /attendance/scan` (token, event_key)
  - `GET /me/attendance?from&to`
  - `POST /attendance/corrections`
  - `GET /me/dtr/:period`
  - `POST /me/dtr/:period/confirm`
- **Head Nurse:**
  - `GET /manager/attendance/board`
  - `POST /manager/attendance/attest`
  - `GET/POST /manager/attendance/exceptions/:id/resolve`
  - `POST /manager/coverage-changes`
  - `POST /manager/overtime/:id/decide`
  - `POST /manager/dtr/:period/certify`
- **HR timekeeper:**
  - `GET /hr/periods`
  - `POST /hr/periods/:id/lock`
  - `GET /hr/exceptions`
  - `GET /hr/dtr/:period/export` (CSV and Form 48 PDF)
- **Payroll:**
  - `POST /payroll/runs` (from a locked period)
  - `GET /payroll/runs/:id`
  - `POST /payroll/runs/:id/submit`
- **Finance:**
  - `POST /finance/runs/:id/approve|return`
  - `POST /finance/runs/:id/release`
- **Devices:**
  - `POST /devices/events` (signed batch, replay-protected, offline buffer)
  - `GET /devices/:id/qr` (station display)

### 5.1 Attendance capture options (Phase 3 pilot)

| Method | Strength | Weakness | Pilot role |
|---|---|---|---|
| Static QR | trivial | photo relay, buddy punching | no |
| **Rotating QR at a staff-only station + signed-in phone** | cheap, relay window of seconds, ties to the account | phone needed (restricted-phone areas), shared credentials | **yes (pilot)** |
| Managed kiosk (shared tablet, staff PIN or badge) | no personal phone needed | PIN sharing | fallback |
| Supervisor attestation | works in outages and with gloves or masks | trust-based, so it's flagged and audited | **yes (fallback)** |
| Passkeys | phishing-resistant sign-in | doesn't prove location | later, for privileged actions |
| Geofencing | none indoors | poor indoor accuracy, privacy | no |
| Fingerprint/face terminal | strong presence | hygiene, masks, biometric privacy | later, through the device adapter, matching at the terminal |

Biometric data stays at the terminal or gateway. The app receives only "profile X, in, at T, device D, signed".

---

## 6. Phase plan, dependencies and gates

| Phase | Work | Must pass before the next phase |
|---|---|---|
| **0** (this document) | audit and plan | your approval |
| **1a** Baseline | commit the 118 pending paths in separate commits per session; create a GitHub repository and remote (your account); add `ci.yml` (install, typecheck, test, build); record the baseline results | CI green on GitHub; baseline recorded |
| **1b** Move | `git mv apps/web frontend`, `server backend`; all paths in §2.1; `.env.example` complete | typecheck, 195+ tests, both builds, `docker build` of both images, local sign-in, invite/reset, role boundaries, schedule, leave, endorsement, Mica |
| **1c** Fix confirmed gaps | leave impact by shift overlap (not start date); no-approver path → Nursing Service/other manager, link `/manager/leave`, never the admin; document the migration prefix | new tests for each |
| **1d** Tidy | frontend `layouts/api/composables`; backend `services/` | same checks |
| **1e** Deploy validation | optional, needs your accounts: Supabase, Render, Vercel staging, plus smoke tests | health, sign-in, invite link, CORS |
| **2** Android | Capacitor 8 in `frontend`, `android/` project, `VITE_API_URL` per environment, CORS for `capacitor://localhost` / `https://localhost`, back button, safe areas, status bar, offline banner, session storage review; `android-apk.yml` (manual plus tag trigger) producing a debug APK artifact | APK built **by a GitHub run**, installed, signs in to the test API |
| **3** Attendance pilot | §5 attendance tables, QR station, attestation, reconciliation, exceptions, coverage changes, board states; leave-by-overlap reused | reconciliation tests (overnight, leave across midnight, swaps, duplicates, missing punch) |
| **4** DTR and roles | capabilities, Nursing Service, HR, Payroll, Finance workspaces, DTR versions, certification, period lock, Form 48 export, payroll handoff quantities | two parallel cutoffs against independently checked records |
| **5** Payroll, Mica, hardware | compensation, runs, lines, approvals, payslips for **one** pay group; Mica attendance facts (local, deterministic, role-scoped); privacy documentation | Finance sign-off; labelled sample calculations |

**Tool versions for Phase 2** (verified on capacitorjs.com, Capacitor 8):
- Node **22+**. The repository says `>=20.12`, so CI uses 22.
- Android Studio 2025.2.1+; the newest SDK is API 36. A JDK isn't installed separately because Android Studio bundles one; CI uses Temurin 21.
- Exact Gradle and AGP versions are taken from the generated `android/` project at Phase 2.

---

## 7. Philippine rules and hospital decisions needed before payroll

Rules differ between **government** hospitals (CSC, DBM, COA rules) and **private** hospitals (Labor Code, DOLE). Starlight Community Hospital is fictional, so the demo must pick one.

| Topic | Government hospital | Private hospital |
|---|---|---|
| DTR | CSC Form No. 48: staff honor certification plus "verified as to prescribed office hours" by the in-charge (copies of the form seen; confirm the current CSC version) | the hospital's own DTR; DOLE requires time records |
| Night differential | RA 11701: up to 20% of hourly basic rate for 6 PM–6 AM; IRR sets **at least 10%** for public health workers; hourly rate = monthly ÷ 22 ÷ 8; subject to available funds | Labor Code: +10% for 10 PM–6 AM (to be cited from the DOLE handbook in Phase 5) |
| Overtime, holidays, rest days | CSC/DBM rules, CTO (compensatory time-off) common | Labor Code premiums (+25% ordinary-day OT, holiday and rest-day rates) |
| Health-worker benefits | Magna Carta of Public Health Workers (RA 7305), DBM circulars | per contract and CBA |
| Privacy | Data Privacy Act (RA 10173) and NPC circulars for both: lawful basis, PIA, retention, DPO, breach handling, possible NPC registration |

Decisions for the hospital (HR, Finance, DPO). Needed before Phase 4/5, **not** before Phase 1:
1. Employer type: government (LGU/DOH-retained) or private.
2. Employment categories (plantilla/permanent, casual, contract of service, job order) and which are on payroll versus billing.
3. Pay groups and cutoffs (e.g. 1–15 and 16–end, or monthly), pay dates.
4. DTR format and signatories (in-charge, Chief Nurse, HR), and who certifies a Head Nurse's own DTR.
5. Leave credits (VL/SL accrual, CTO), leave without pay handling.
6. Break rules (paid or unpaid meal break on 8- and 12-hour duty).
7. Overnight attribution: split at midnight for holidays and cutoffs, or attribute to the start date.
8. Overtime authority, OT versus CTO, premium buckets.
9. Grace period and rounding for lateness and undertime.
10. Retention periods (DTR, payroll, raw device evidence) and who may export.

---

## 8. Privacy controls (all phases)

- Payroll and Finance views get **certified quantities only**. No leave reasons, medical details, raw scans or unrelated unit records.
- Mica uses **local deterministic queries** for attendance, DTR and payroll questions. Salary, raw evidence, leave reasons and biometrics are never sent to an external AI.
- A separate audit stream (`audit_logs.domain = 'hr'|'payroll'`) records reads of sensitive views, exports, corrections, approvals and releases.
- Restricted exports: role-scoped, watermarked with who and when, logged.
- Strong authentication for privileged actions (step-up / passkey) in Phase 4.
- Encrypted transport (HTTPS only, also in the APK), encrypted backups, `SECRETS_ENCRYPTION_KEY` for stored secrets.
- Android: the session token is kept in Capacitor secure storage (Keystore-backed) instead of `localStorage`, plus an idle sign-out.
- Documentation with the DPO: lawful basis, privacy impact assessment, retention schedule, correction rights (the staff correction path above).

---

## 9. Decisions for you now

1. **Approve Phase 1** (baseline commits → CI → folder move → gap fixes → tidy). Recommended start.
2. **GitHub repository:** there is no remote. Create one (private) and tell me its URL, or let me add the workflow files locally only. Without it, CI and the APK workflow can't run.
3. **Pending work from other sessions:** commit it as separate commits first (recommended), or leave it uncommitted. I won't overwrite it either way.
4. **Live hosting validation (1e):** now, later, or skip until after Android.
5. **Demo employer type** for Phases 4–5: government (recommended for a Philippine public-hospital demo) or private.

Sources:
- [Capacitor environment setup](https://capacitorjs.com/docs/getting-started/environment-setup)
- [RA 11701 (Lawphil)](https://lawphil.net/statutes/repacts/ra2022/ra_11701_2022.html)
- [IRR of RA 11701 (CSC)](https://csc.gov.ph/phocadownload/userupload/hrpso/issuances/RA11701/IRR%20RA%2011701.pdf)
- [CSC Form 48 sample (Slideshare copy, verify with CSC)](https://www.slideshare.net/slideshow/dtrpdf-255739199/255739199)

---

## 10. Phase 1 results (9 November 2026, branch `phase-1-restructure`)

| Commit | What |
|---|---|
| `9d8aff2` | Pending account work from the other sessions: invitations, password reset, Gmail sender, go-live, deployment files |
| `cccb864` | Pending web work: Ionic Vue throughout, hospital wording, sign-in/set-password/forgot-password pages |
| `03adc91` | `apps/web` → `frontend`, `server` → `backend` (history kept with `git mv`), every path updated, `.github/workflows/ci.yml` |
| `5d2d2e7` | Leave impact shows overnight shifts that run into the leave (`partial`), no-approver requests go to IT as "add an approver" with no leave details, migration-name note |
| (this commit) | `backend/src/services/schedule.ts` (board and schedule queries, used by routes and Mica); `frontend/src/composables/` and `frontend/src/layouts/`; complete `backend/.env.example` |

**Baseline (before the move) and result (after Phase 1):**

| Check | Baseline | After |
|---|---|---|
| Typecheck (shared, backend, frontend) | clean | clean |
| Shared tests | 8 passed | 8 passed |
| Backend tests | 196 passed | **198 passed** (2 new leave tests) |
| Backend and frontend builds | pass | pass |
| Built API on an empty database | — | all 28 migrations applied from `backend/dist`, first admin created, `/api/health` 200 |
| Smoke test (presentation data, source mode) | — | 18/18: sign-in per role, wrong password 401, staff/Head Nurse/admin boundaries, admin blocked from leave and review, forgot-password does not reveal accounts |
| Docker images | not run | **not run here**: Docker Desktop was not running. The CI `docker` job builds both |
| CI on GitHub | — | **not run**: the repository has no remote yet |

**Outstanding before Phase 2:**
- Create the GitHub repository, push `phase-1-restructure`, and confirm the CI run is green, including the Docker job.
- In Vercel (when deployed), set **Root Directory** to `frontend`. Render reads `./backend/Dockerfile` from `render.yaml`.
- The `outputs/` folders (about 330 MB of presentation and video files) stay untracked on disk. GitHub rejects files over 100 MB; keep them outside the repository or use Git LFS.
- A copy of the local databases and `.env` from before the move is at `.tmp/data-backup-2026-11-09/` (ignored by git).
