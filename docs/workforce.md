# Attendance, DTR and payroll

Built on the existing duty schedule and leave. The roster stays the plan; attendance is the
evidence; the DTR is what the department head certifies; payroll uses certified totals only.

## Who does what

| Person | Base role | Duty (capability) | Pages |
|---|---|---|---|
| Staff nurse / nursing attendant | employee | — | Attendance, My DTR, Payslips |
| Head Nurse | manager | — | Attendance (unit), DTR certification, My DTR, My payslips |
| Chief Nurse / Nursing Service | manager | `nursing_service` (one unit or all) | Supervises other units' attendance; certifies a Head Nurse's own DTR |
| HR timekeeper | employee (HR department) | `timekeeper` | HR timekeeping: periods, pay groups, lock, CSV |
| HR administrator | employee | `hr_admin` | Pay rules view, compensation settings |
| Payroll personnel | employee | `payroll_preparer` | Payroll: prepare and submit runs, adjustments |
| Finance | employee | `finance_approver` | Payroll approval: approve or return, release |
| IT administrator | admin | can't hold any | Grants and removes duties on User accounts; sees no attendance or pay data |

The database enforces it:
- Nobody verifies, certifies or approves their own attendance, DTR, overtime or pay.
- The payroll preparer can't approve their own run.
- Payroll and Finance can't read punches, device data or leave reasons.

## The flow

1. **Plan.** The Head Nurse rosters as before. Every roster change is versioned (`duty_expectations`).
2. **Time in and out.** At the unit's **QR station**, a tablet opens the station's setup link and shows a code that changes every 30 seconds. Staff scan it in Attendance (Chrome on Android or the app), or type the 6 digits.
   - The punch is append-only and has a unique key, so a retry is harmless.
   - Fallback when the station is down, gloves are on, or phones are not allowed: the Head Nurse **attests** the time, with a reason.
3. **Reconcile** (automatic, repeatable). Punches are matched to the assigned duty. Each duty shows as scheduled, clocked in, verified present, incomplete, no time-in, absence confirmed, or on leave.
   - Approved leave excuses the duty (paid or unpaid by leave type). Pending leave becomes a review item.
   - Duties from before a unit's first station or punch stay unverified history; they are not marked as absences.
4. **Settle.** The Head Nurse:
   - verifies complete duties;
   - confirms absences and decides overtime (pay or compensatory time, never more than recorded);
   - approves staff **corrections** for a missing or wrong punch (the original punch is never changed);
   - records **cover** for a shift: who covered whom, who authorised it, emergency or after the fact.
5. **DTR.** Per cutoff, each person's DTR is built from the reconciled records. Overnight duty is split at midnight (sample rule).
   - The staff member **confirms** it (honor statement). The Head Nurse **certifies** it once nothing is open.
   - It prints in a Form 48 layout.
6. **Lock.** HR locks the period once every DTR in the pay group is certified. The records freeze; later fixes become adjustments in a later run.
7. **Payroll.** Payroll prepares a run from the certified totals and the versioned policy, then submits it.
8. **Finance.** A different person approves or returns the run, then releases it. Staff see their payslips.

## Sample rules (must be confirmed)

The demo policy (`workforce_policies` version 1) is labelled **sample** for a government hospital:
- hourly rate = monthly ÷ 22 ÷ 8;
- night differential 10% for 6 PM–6 AM (the floor for public health workers in the RA 11701 IRR);
- overtime 125%;
- no grace period;
- semi-monthly cutoffs.

Taxes, GSIS/SSS, PhilHealth and Pag-IBIG are **not** computed. Each rule needs confirming with the hospital's HR and Finance (and DBM, CSC and COA rules for government; DOLE for private) before real use.

## Hardware later

A fingerprint or face terminal (or its gateway) can post signed batches to `POST /api/devices/:id/events`:
- headers: `X-Device-Timestamp`, and `X-Device-Signature` = HMAC-SHA256 of the timestamp and body;
- each event carries a unique key, a staff number mapped to an account, in or out, and the capture time;
- events are buffered and retried safely, and the clock drift is recorded.

Matching happens at the terminal. No biometric data reaches the app.

## Privacy

- Mica answers attendance, DTR and payroll questions from local queries, with the period and whether figures are provisional or certified. No pay amounts, punches or leave reasons go to an external AI.
- Exports (CSV of certified totals) and every decision are in the audit log.
- Before real use, agree the following with the hospital's Data Protection Officer: lawful basis, privacy impact assessment, retention periods, and correction rights.

## Set it up

```bash
npm run demo:workforce
```

Run it with these variables: `API_URL`, `ADMIN_EMAIL`/`ADMIN_PASSWORD`, `HEAD_EMAIL`/`HEAD_PASSWORD`, `NEW_PASSWORD` (for the HR, Payroll and Finance accounts it creates), and `EMAIL_DOMAIN`. The script prints nothing secret except the station setup link.
