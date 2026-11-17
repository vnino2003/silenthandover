# Presentation on the live system

`npm run demo:live` fills the **live** Silent Handover (or a local one) with a fictional Nursery team and about two weeks of realistic activity. It works only through the app's own API, signed in as each person, so every rule, notification and audit-log entry is genuine. Every person is fictional, and there is no patient information.

## Accounts

The script creates every account with a password already set. You choose **one demo password** for all of them. No invitation is sent and no inbox is needed. The addresses use the reserved `.test` domain, and every demo account has email alerts turned off. Your own admin account is not changed.

| Role | Name | Sign-in |
|---|---|---|
| Head Nurse (department head, Nursery) | Maria Santos | maria.santos@starlight.test |
| Day shift | Ana Lim, Juan Dela Cruz, Rosa Villanueva, Paolo Garcia | `firstname.lastname@starlight.test` (Juan: juan.dela.cruz@starlight.test) |
| Evening shift | Ben Torres, Mae Santiago, Grace Aquino | same pattern |
| Night shift | Carla Mendoza, Daniel Ramos, Leo Fernandez | same pattern |
| HR (timekeeping and HR admin) | Helen Ramos | helen.ramos@starlight.test |
| Payroll | Pablo Reyes | pablo.reyes@starlight.test |
| Finance | Fiona Tan | fiona.tan@starlight.test |
| Chief Nurse (Nursing Service) | Nora Bautista | nora.bautista@starlight.test |

## What it creates

- **Departments:** Nursery (with the Nursery wording), Human Resources, Accounting Office, Nursing Service Office.
- **Schedule:** Day 06:00–14:00, Evening 14:00–22:00 and Night 22:00–06:00, with minimum staff 3/2/2. Duties, rest days and a rotation run from the start of the previous cutoff to two weeks ahead.
- **Unit records:** the endorsement policy, the readiness checklist, the vaccine cold-chain log, supply par levels and the coverage briefing.
- **Concerns:**
  - the vaccine refrigerator above 8 °C (safety concern, assigned to Juan);
  - screening filter cards running low (in progress);
  - the ID band printer, raised by Rosa (waiting for the Head Nurse to verify it).
- **Leave:** one approved (Paolo), one declined (Ben), and two waiting for the Head Nurse (Leo, Mae).
- **Endorsements:**
  - Juan's is analysed by Mica, approved, and read by the incoming Evening crew.
  - **Paolo's is waiting for the Head Nurse's review**, so you can approve it live.
- **Attendance, DTR and payroll:**
  - a QR station;
  - the pay group with monthly pay per person;
  - time-in and time-out for every past duty, entered from the "attendance logbook" because these duties came before the station. A few in the current cutoff are 12 minutes late.
  - **The previous cutoff is done end to end:** duties verified, DTRs confirmed by staff and certified by the Head Nurse, the period locked by HR, and payroll prepared by Pablo. **The payroll is waiting for Finance (Fiona) to approve**, so you can approve it live.
  - Today's duties are left for live QR scanning.

The system itself still shows two "sample" labels: the pay group name *Nursing service — salaried (sample)* and the payroll rules (rates, night differential). They mean the rules have not yet been confirmed with a real hospital's HR and Finance, and that is the honest answer if the panel asks.

## Steps

1. **Wake the server.** Open https://api-handover.natsgo.app/api/health in a browser and wait for `"ok"`.
2. **Optional:** sign in as admin and check that the AI is connected (Settings → AI), so Mica analyses the endorsements with the real model.
3. In PowerShell, from the project folder:

   ```
   npm run demo:live
   ```

   It asks for:
   - the API address (press Enter for https://api-handover.natsgo.app);
   - your admin email;
   - your admin password (hidden);
   - the password for all demo accounts (hidden, at least 10 characters).

   Type `YES` to start. It takes about 5–10 minutes, mostly while it waits for Mica.
4. **Keep the QR station link** it prints, and open it on the tablet or laptop used as the station. Keep the link private. Head Nurse → Attendance → Stations can make a new one.
5. **On the morning of the presentation, run it again** (same passwords). It skips what exists and only adds time-in/out for the duties that ended overnight.

Running it again is safe: what already exists is skipped. If it stops on "sign-in limit", it waits and retries by itself.

## Suggested flow during the demo

1. **Staff (Ana or Paolo):** dashboard, own schedule, leave request, scan the QR station (time-in).
2. **Head Nurse (Maria):**
   - review **Paolo's endorsement** with Mica's analysis and approve it;
   - check concerns, leave waiting for approval and the duty board;
   - show attendance (late, missing time-in) and the DTRs.
3. **Incoming staff (Evening crew):** read the handover.
4. **HR (Helen):** cutoffs, pay group, DTR export.
5. **Payroll (Pablo):** the prepared payroll.
6. **Finance (Fiona):** **approve the payroll**, then release it. Staff can then see their payslip.
7. **Admin (you):** users and duties, audit log, settings.

## After the presentation

```
npm run demo:live -- --cleanup
```

This deactivates every `@starlight.test` account, so they can no longer sign in. Their history (schedules, endorsements, audit log) stays and shows them as inactive people. Before real hospital use, start from a clean database (for example a new Supabase project) rather than deleting rows by hand.

## Options

Set these before running (PowerShell: `$env:NAME = "value"`):
- `API_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `DEMO_PASSWORD`: skip the questions.
- `EMAIL_DOMAIN`: another domain for the demo sign-ins (default `starlight.test`; keep a `.test` domain so nobody real is ever emailed).
- `WEB_URL`: the web address used in the printed station link.
- `--yes`: skip the `YES` confirmation.
