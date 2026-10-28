# Presentation guide (29 October 2026)

The local app runs on a clean **presentation database** built by `npm run presentation:prepare`. Everything in it is fictional (Starlight Community Hospital, Newborn Care Department), and it contains no patient information. The activity was created by running the real workflows, so every record and audit entry is genuine output of the system.

## Start it

```
npm run dev
```

Open http://localhost:5173. Every account uses the local demo password (see `README.md`, "Newborn Care demo").

| Role | Name | Sign-in |
|---|---|---|
| Administrator | Alex Reyes | alex.reyes.starlight@gmail.com |
| Supervisor (shift lead) | Maria Santos | maria.santos.starlight@gmail.com |
| Day shift | Juan Dela Cruz, Ana Lim, Paolo Garcia, Rosa Villanueva | `firstname.lastname.starlight@gmail.com` (Juan: juan.dela.cruz.starlight@gmail.com) |
| Evening shift | Ben Torres, Grace Aquino, Mae Santiago | same pattern |
| Night shift | Carla Mendoza, Daniel Ramos, Leo Fernandez | same pattern |

The addresses only sign in. Email sending is not set up ("coming soon"), so nothing is ever sent to them.

## What is already in the system (28 October)

- **Two weeks of schedule:**
  - Day, Evening and Night shifts with minimum staffing (Day 3, Evening 2, Night 2), weekly rest days and a rotation.
  - Some shifts are deliberately one person short, so the board shows real conflicts.
- **Juan's Day report, the full cycle:**
  - The report was late, so Maria allowed it with a reporting override.
  - Mica cleaned it, and Maria reviewed and approved it.
  - It was delivered to the Evening crew. Ben has read it; Grace hasn't yet.
- **Paolo's Day report:**
  - Mica's draft is ready and **waiting for Maria's review**.
  - It shows verification flags: the shelf he "fixed himself" is an unverified repair, and the glove counts differ.
  - "Sir Ramos" was replaced by a code before anything went to the AI.
- **Open concerns:**
  - Bassinet NB-02 wheel lock: safety, high, assigned to Juan.
  - Call bell: in progress with facilities.
  - Plus anything created when Juan's report was approved.
- **Four source records** used during review: the policy, the readiness checklist, the maintenance review and the staffing record.
- **Leave:**
  - Paolo: approved.
  - Ben: declined, with a note.
  - Leo: sick leave, pending. It would leave a Night shift short, which shows in the staffing impact.
  - Mae: vacation, pending.

## Suggested demo flow

1. **Supervisor (Maria):**
   - On **Review queue**, open Paolo's report. Compare the original with Mica's draft, go through each flag, check the source records, then approve.
   - On **Leave requests**, open Leo's request. Check the staffing impact, then decide.
   - On **Schedule → By person**, look at the week and the coverage.
   - Open **Ask Mica** and try "Pending decisions".
2. **Employee (Juan):**
   - On **Today**, look at the shift and the open concerns.
   - Open **Mica** and choose **Prepare a handover**. Describe the shift in rough words, or with voice in Chrome. Review the prepared report and confirm it.
   - **Reporting window:** a report can be sent only near the end of the shift (Day 13:30–14:30).
     - Before then, Maria allows it from **Today**, using the reporting override. That is a real supervisor control.
   - **Leave:** try "I need Friday off" in Mica, then **Review dates in Leave**.
3. **Incoming staff (Grace or Ana):** open **Shift takeover** and acknowledge the handover.
4. **Administrator (Alex):** open **Mica AI pipeline**:
   - Real reports (censored), showing exactly what went to the AI.
   - Mica assistant prompts.
   - Organization rules.

   Also show **Users**, **Departments → Customize** and **Rules and emails**.

## If the AI is slow

While the database was prepared, Gemini timed out three times on Juan's report and answered on the fourth try (**Ask Mica again**). That is the system's normal fallback, shown on the review page and in **Integrations** as "Failed, then retried". If Mica is slow during a live submission:
- The report waits as "Mica is preparing the draft…" and is retried automatically. Continue with Paolo's report, which already has its draft.
- Mica's chat switches to guided questions when the AI doesn't answer, so the employee can keep working.
- Optional: in **Integrations → Change AI settings**, choose a fixed model that answered quickly (for example gemini-3.6-flash) instead of "newest available".

## What changed for the presentation

| | |
|---|---|
| **Kept, unchanged** | The Newborn Care Department setup: wording, report and privacy guidance, concern categories, shift patterns with windows and minimum staffing, leave types, rules and email templates. Also the connected Gemini AI (the key stays encrypted) and the organization rules. |
| **Left out of the presentation database** | The old activity, the "(demo)" practice shifts, the old @demo.test sign-ins, the test accounts made during development (two @gmail.com employees and one supervisor) and the test department "INFORMATION TECNO". All of these are still in the previous database (see below). |
| **Switched off** | `DEMO_MODE=false` in `server/.env`. That hides "Generate example" on the report form and the administrator's "Reset activity" button. |
| **Marked "coming soon"** | Email sending (notifications appear in the app, and email previews are kept), SMS, and the n8n automation card, which shows only when n8n is actually in use. |

## Going back

Nothing was deleted. The previous database is still at `server/.data/newborn-care-demo`, and a copy of it and the old `server/.env` is at `server/.data/backup-2026-10-28-before-presentation`. To return to it:
1. Stop the app.
2. Set `LOCAL_DB_DIR` in `server/.env` back to `server/.data/newborn-care-demo`, and `DEMO_MODE=true`.
3. Start the app again.

To rebuild the presentation database from scratch, stop the app and run:

```
npm run presentation:prepare -- --replace
```
