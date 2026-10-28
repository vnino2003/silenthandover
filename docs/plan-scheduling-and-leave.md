# Plan: shift scheduling and leave management

Status: **implemented** (migrations `20261027000300` and `20261027000400`, `server/src/routes/leave.ts`, tests in `server/test/leave.test.ts`). Open questions were settled with the recommended answers: another supervisor (or the administrator when there is none) decides a supervisor's leave; supervisors set rest days; whole days only; administrators get a read-only board; the hospital example is a separate command.

## 1. What exists today (and what we build on)

| Area | Today | Reuse |
|---|---|---|
| Roles | `employee` (worker), `manager` (supervisor / department head), `admin`. A supervisor manages only their own department (`app.is_manager_of`). | Same roles. "Head Supervisor / Department Head" = `manager`. No new permission system. |
| Shift patterns | `shift_templates`: name, start/end, weekdays, per department, set by the supervisor ("Edit shifts"). | Unchanged, plus a **minimum staff** number per pattern. |
| Dated shifts | `shifts` (auto-created from patterns, or one-off), `status` scheduled / cancelled. | Unchanged, plus `min_staff`. |
| Assignments | `shift_assignments`; `app.assign_to_shift` already refuses **overlapping shifts** and **duplicate assignments**. | Extended: also refuses assigning someone on **approved leave**; warns on a **rest day**. |
| Supervisor pages | **Schedule** (week grid: shift × day, assign people, copy last week) and **Today** (who is on duty now). | Schedule grows into the department board (below); Today gains "on leave today". |
| Worker pages | **Today** shows the current shift, the duty ring and the next 3 shifts. | Gains a short "next days" strip and leave status. |
| Notifications | One system: `app.notify` (in-app + email/SMS per preference), event keys prevent duplicates, links open pages. `shift_assigned` exists. | Same system, new kinds. **Gap today:** removing someone from a shift, cancelling, or moving a shift's time does not notify them. |
| Scheduled checks | `admin/tick` / internal scheduler (escalations, missing reports). | Adds shift reminders and staffing alerts. |
| Settings | `app_settings` key/values on the admin Settings page. | New scheduling and leave rules. |

Nothing hospital-specific exists, and nothing will be hard-coded: shift names already come from patterns; leave types, job titles and staffing minimums will be configuration.

## 2. Database changes (one new migration, same patterns as today)

All writes go through `security definer` functions that check the caller (as everywhere else); row-level security for reads.

1. **`leave_types`** (organisation-wide, set by the admin): name, description, `requires_reason`, optional `max_days_per_request`, `is_active`, sort order. Default rows: *Vacation leave, Sick leave, Emergency leave, Unpaid leave* — all editable.
2. **`leave_requests`**: employee, department, leave type, `start_date`, `end_date` (whole days in v1), reason, `status` = pending / approved / rejected / cancelled, decided by / at, supervisor comment, created / cancelled at.
   - An employee cannot have two pending-or-approved requests on the same dates.
   - **Pending is never treated as approved**: only `approved` affects the schedule.
   - Reasons can be medical (sick leave): visible only to the employee and the supervisors who decide, never to colleagues or admins, and never sent to the AI.
3. **`schedule_day_marks`**: employee, day, kind = `rest_day` or `day_off`, note — set by the supervisor (single days, or "every Sunday from … to …" in the UI). A day with no shift and no mark shows as *Not scheduled*.
4. **`shift_templates.min_staff`** and **`shifts.min_staff`** (copied when a shift is created, editable per shift): the coverage target.
5. **`profiles.job_title`** (optional, free text, set by the admin), e.g. *Staff nurse*, *Forklift operator*. Shown on the board.
6. New settings: `leave_min_notice_days` (default 0), `shift_reminder_hours` (default 12, 0 = off), `leave_cancel_pending_allowed` (default true).

## 3. Workflows

### Scheduling (supervisor)
- Assign / move / remove people from the board without opening profiles.
- Validation (in the database, so it can't be bypassed): no overlapping shifts, no duplicate assignment, **no assignment on approved leave**; a **rest day** gives a warning the supervisor can confirm.
- Every change notifies the employee: assigned, removed, cancelled, time changed.

### Leave
```
Employee: choose dates + type (+ reason if required) → Submit → status Pending
   → supervisors of the department are notified ("New leave request")
Supervisor: sees the request with its impact:
   - shifts the employee is assigned to on those dates
   - coverage of those shifts if approved (e.g. "Night, 12 Nov: 2 of 3 — understaffed")
   → Approve (optional comment) or Reject (comment required)
On approval: the leave shows on the employee's schedule and the board; the employee is removed
   from the overlapping shifts (recorded in the audit log) and told so; supervisors are alerted
   about any shift that is now understaffed.
Employee: can cancel while Pending; cancelling an approved leave goes through the supervisor.
```
- Nobody approves their own leave. **Open question A** below: who approves a supervisor's leave.

### Notifications (existing system, new kinds)
Employee: `shift_assigned` (exists), `shift_changed`, `shift_removed`, `shift_cancelled`, `shift_reminder` (before a shift, via scheduled checks), `leave_approved`, `leave_rejected`, `leave_changed`. Supervisors: `leave_requested`, `staffing_gap` (approved leave or a removal leaves a shift below its minimum, or an upcoming shift is understaffed). Each links to the right page.

## 4. Pages

### Supervisor
- **Schedule → Department board** (the existing page, extended — no duplicate page):
  - Views: **Day · Week · Month**, with ← Today → navigation that keeps the selected date.
  - Two layouts: **By shift** (today's grid: shifts × days, people in each cell) and **By person** (roster: one row per employee, each day showing their shift, *Rest day*, *Day off*, *On leave*, or *Pending leave* hatched).
  - **Coverage row** per shift and day: "3 / 3", amber when below minimum, red when empty.
  - **Conflicts panel**: understaffed shifts, pending leave that would cause a shortage, assignments on rest days.
  - Filters: date range, employee, shift. (Department is fixed to the supervisor's own; see question D.)
- **Leave requests** (new page, menu item with a pending count): pending queue with impact, decision dialog with comment, history with filters.
- **Today**: adds "On leave today" and "Off today".

### Employee
- **Today** (existing): the next shift stays first; adds a 7-day strip (shift / rest / leave) and a leave-status line.
- **My schedule** (new): upcoming shift card at the top; **List** and **Calendar** toggle; rest days, days off and approved leave clearly marked; pending leave shown as pending.
- **Leave** (new, or a tab of My schedule): request form, status of each request (pending / approved / rejected with the supervisor's comment), cancel while pending, history.
- Bottom bar on phones: *Today · Takeover · Schedule · Issues · Reports* (Schedule added).

### Admin
- **Settings → Scheduling & leave** (new section): leave types editor, reminder hours, notice days, cancel rule.
- **Users**: job title field.

## 5. Permissions

| Action | Employee | Supervisor (own department) | Admin |
|---|---|---|---|
| See own schedule, rest days, leave | ✓ | ✓ | — |
| See department board | — | ✓ | question D |
| Create / edit / assign shifts, set rest days | — | ✓ | — |
| Request leave | ✓ | ✓ (question A) | — |
| Approve / reject leave | — | ✓, never their own | question A |
| Leave types, scheduling rules, job titles | — | — | ✓ |

All enforced in the database functions and RLS, then mirrored in the API and menus (as today).

## 6. Sample data: Newborn Care Department

**Already started elsewhere:** a parallel session added an industry-independent department
configuration and a synthetic *Starlight Community Hospital — Newborn Care Department* demo (24-hour
Day / Evening / Night patterns, seven accounts, installed as a separate local database). That work is
**not committed yet** (see `docs/industry-upgrade.md`).

The scheduling and leave sample data will **extend that demo**, not create a second one: add staff to
about 10 (fictional, with job titles such as *Staff nurse*, *Midwife*, *Nursing attendant*), minimum
staff per pattern, two weeks of assignments, weekly rest days, and leave requests in every state
(pending, approved, rejected) — including one pending request that would leave a night shift
understaffed so the warning is visible. No patient information. The warehouse setup stays available.

## 7. Delivery in phases (each tested and committable on its own)

1. **Data and rules**: migration, functions, permissions, notifications for shift changes; tests.
2. **Leave flow**: employee request / cancel, supervisor decision with impact; tests.
3. **Department board**: day / week / month, by shift / by person, coverage, conflicts, filters.
4. **Employee schedule**: My schedule, leave page, Today additions, reminders.
5. **Admin settings, sample Newborn Care data, docs**.

## 8. Open questions

- **A. A supervisor's own leave**: approved by another supervisor of the same department, and by the admin when there is none? (Recommended.)
- **B. Rest days**: set by the supervisor per employee (weekly pattern + single dates)? (Recommended.) Or should employees request rest days too?
- **C. Half-day leave**: whole days only in this version? (Recommended.)
- **D. Admin view of schedules**: a read-only, organisation-wide board with a department filter, or no schedule access for admins (they don't need it to configure rules)?
- **E. Sample data**: as a separate command (recommended, keeps live data clean), or loaded on first start as before?

## 9. How to try it

```
npm run demo:schedule
```

Run it while the local app is running with the Newborn Care demo. It adds five more fictional staff with job titles, minimum staffing (Day 3, Evening 2, Night 2), two weeks of rotating shifts with weekly rest days, and four leave requests (approved, declined, and two pending — one of which would leave a night shift short). It goes through the app's own API, so every rule applies; running it again changes nothing.

- Supervisor (maria.santos@demo.test): **Schedule → By person** (day / week / month board), **Leave requests**.
- Worker (e.g. leo.fernandez@demo.test): **My schedule**, **Leave**, and the week strip on **Today**.
- Administrator (admin@demo.test): **Rules and emails → Leave types** and job titles on **Users**.

**Changed on 29 October 2026:** administrators no longer see department schedules or leave, and no longer decide leave (questions A and D reversed). A supervisor's own leave needs another supervisor of the same department; without one it is refused with a clear message (migration `20261029000100`).
