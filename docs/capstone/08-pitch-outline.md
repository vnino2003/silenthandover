# 8. Five-Minute Individual Capstone Pitch Outline

**Setup before you start:** `npm run dev`, sign-in page open, sign in as Maria (supervisor) →
**Schedule → Create demo shifts** (so Juan's reporting window is open right now). Have two browser
windows: worker and supervisor.

**One-line framing:** "One department — Warehouse Inventory (Track C). Workers report, the supervisor
approves, the next shift receives it. The admin only sets the system up. More departments can be added
later without code changes."

| Time | Section | Say | Show |
|---|---|---|---|
| 0:00–0:30 | **Hook** | "At every shift change, a warehouse loses information. A soft forklift brake mentioned at 2 PM is forgotten by 10 PM." | Login page "How a handover moves" |
| 0:30–1:00 | **Problem & audit** | High frequency (every shift, every employee), rule-bounded (windows, approvals, issue states), digital ingestion (web form). So: automate the drafting and tracking, keep humans on the decisions. | Doc 1 table |
| 1:00–1:45 | **Step 1–2: Intake & sanitize** | Juan submits during the window the *server* enforces. Click **Use sample**: Taglish, a phone number, a colleague's fever, and an injection attempt. Before anything reaches the AI, names become pseudonyms and contact and health data are removed. | Juan's Today page countdown → report form → submit. Supervisor's review page → **Sent to AI (sanitized)** tab |
| 1:45–2:30 | **Step 3: Bounded AI** | Six elements: role, objective, policy rules, `<raw_input>` shield, negative constraints, strict JSON. In this demo the draft comes from a labeled simulator; in production, n8n calls the model. The system never claims AI ran when it didn't. | Doc 3; the yellow "Simulated draft" banner; the dev-mode banner |
| 2:30–3:30 | **Step 4: Human gate** | Grounding checks found an unverified repair, a safety hazard, and the injection attempt. Approve stays disabled until I decide every flag. The draft suggests linking "Dock 3 door sensor" to ISS-000002 — I confirm it. | Click a flag's quote → evidence highlights in the original; resolve flags; link issue; approve |
| 3:30–4:15 | **Step 5: Delivery & continuity** | Ana gets only the approved version and acknowledges it. Acknowledging doesn't close anything: issues stay open until a supervisor verifies. | Ana's Incoming handover → acknowledge; Open issues; try "Verify as resolved" as employee (not offered) |
| 4:15–4:45 | **Trust** | RLS in the database: admins can't read reports; managers only their department. Every decision audited. RA 10173 minimization. 82 automated tests, including injection and hallucinated-repair cases. | Admin Integrations (counts only, dev outbox with link-only emails); Audit log |
| 4:45–5:00 | **Close & honesty** | "Next: connect n8n and a model, run the prompt regression suite on v1.0 and v1.1, and record the results. Everything you saw is real code; the AI step was simulated and labeled." | Doc 4 "Pending" column |

## Likely questions

* *What if the AI is down?* — Retries with backoff, then the supervisor gets the original for manual review. Nothing is stuck.
* *Can a report talk the AI into approving itself?* — No. The model has no tools, its output can't set `requires_human_review` to false, and only a supervisor's action approves.
* *Why not let the AI close issues that weren't mentioned?* — Absence isn't evidence. Issues stay open and escalate until verified.
* *Is real data safe to use?* — Not until the provider's retention terms are documented and the DPO signs off (doc 5).
* *Who approves the report?* — Only the supervisor of that department. Not the admin, not the AI, and never the person who wrote it.
* *Why doesn't the admin make the schedule?* — The supervisor knows who is available. The admin only sets up accounts and departments once.
* *What about more departments?* — Built in. The admin adds a department and its supervisor; their reports, schedule and approvals stay separate.
