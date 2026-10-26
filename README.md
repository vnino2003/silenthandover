# Silent Handover

**AI-assisted workplace risk and task continuity.** Employees submit end-of-shift reports in a
server-enforced window; personal data is removed; a bounded AI prompt drafts a structured handover;
a supervisor verifies every claim and approves it; the incoming shift receives the approved version
and acknowledges it; unresolved issues persist across shifts until an authorized person verifies them.

TESDA AI Automation Capstone — see [`docs/capstone/`](docs/capstone/README.md).

## What is real and what is simulated

| Part | Status in this repository |
|---|---|
| Web app — Worker, Supervisor, Admin portals | Implemented, verified in the browser |
| Database schema, RLS, workflow rules (PostgreSQL) | Implemented, 82 automated tests passing |
| PII sanitization, injection detection, schema validation, grounding checks | Implemented, tested |
| AI drafting | **Development simulator** (labeled in the UI). The n8n + model path is implemented and tested against a simulated n8n; **not yet verified against a live n8n or model** |
| Email | **Dev outbox** (recorded as "simulated"). Resend (direct or via n8n) implemented, **not yet verified live** |
| SMS | Optional authenticated n8n transport implemented; off by default and not yet verified with a live provider |
| Supabase (Auth + hosted Postgres) | Implemented; **not yet run against a Supabase project** |
| Deployment | Instructions and container files only; nothing deployed |

All data is synthetic.

## Quick start (no accounts needed)

Requirements: Node.js 20.12+ (tested on 24).

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:5173>. The first start creates a local database and synthetic demo data
(about 30 seconds). Sign in with one of the demo accounts below. All of them use the local test
password `demo-handover-2026` (synthetic data, local only — the sign-in page does not list them).

The demo is one department, **Warehouse Inventory** (TESDA Track C: Admin & Inventory Operations).

| Account | Email | Role | Does |
|---|---|---|---|
| Juan Dela Cruz | juan.delacruz@demo.test | Worker | Submits his end-of-shift report (his "Morning (demo)" window is open) |
| Maria Santos | maria.santos@demo.test | Supervisor | Sets the shifts, builds the schedule, **approves every report**, verifies fixed issues |
| Ana Lim, Ben Torres | ana.lim@demo.test, ben.torres@demo.test | Workers on the next shift | Read the approved handover and take over its checklist |
| Alex Reyes | admin@demo.test | Admin (IT/HR) | One-time setup: accounts, departments, settings, integration health. Cannot read or approve reports |

**Who approves?** Only the department's supervisor — never the admin, never the AI, and never the
person who wrote the report.

**Adding departments later:** the admin adds a department and its supervisor under *Departments* and
*Users*; that supervisor then builds their own schedule. Departments never see each other's reports.

The demo shifts are created relative to the time you seed. When the outgoing window has passed, sign
in as Maria and click **Schedule → Create demo shifts**.

### How shifts work

1. **Shift types** — e.g. Morning 6:00 AM–2:00 PM. Reporting opens 30 minutes before the end and
   closes 30 minutes after (both adjustable).
2. **Add next 7 days** — creates the actual shifts for each day.
3. **Who's on duty** — the supervisor adds workers to each shift.
4. When a report is approved, it goes automatically to the workers on the **next** shift.
5. Missed the window? The supervisor can allow a late submission from *Today's shifts*; it is marked late.

### Demo walkthrough

1. **Juan** → *Submit shift report*. Answer the short questions: what you finished; any problems
   still open (*Yes* → *Add a problem*: type, where, what happened); problems from earlier shifts
   (*Still there / Being fixed / Fixed*); anything for the next shift. Or tap *Use sample*. *Send report*.
2. **Maria** → *Review queue* → open the report. Compare the original with the draft, open *Sent to AI
   (sanitized)*, click a flag's quote to highlight its evidence, choose a decision for every flag,
   confirm the suggested issue links, *Approve handover*.
3. **Ana** → *Incoming handover*. Her **checklist** shows every open problem and task from Juan's
   shift. *Mark done* → what she did + an optional photo as proof → it waits for the supervisor.
   *I've read this handover* to acknowledge.
4. **Maria** → *Issues* → *Needs verification* → open it, see the photo → *Confirm done* (or *Send back*).
5. Anything not finished stays on the list for the next shift, and Ana's own report can add new problems.
6. **Alex** → *Integrations* → automation events, deliveries, and the dev outbox.

### The handover loop

```
Worker reports problems + tasks ─▶ Supervisor checks & approves ─▶ Next shift gets it (app + email)
        ▲                                                                   │
        │                                     Checklist: Mark done + photo  ▼
        └──── still-open items carry over ◀── Supervisor confirms done ◀────┘
```

## Commands

| Command | Does |
|---|---|
| `npm run dev` | API on :8787 and web on :5173 (Vite proxies `/api`) |
| `npm test` | All automated tests |
| `npm run typecheck` | TypeScript for shared, server and web |
| `npm run build` | Production builds (`server/dist`, `apps/web/dist`) |
| `npm run seed -- --reset` | Local mode: delete the local database and reseed |
| `npm run prompt:eval -- --version 1.0` | Prompt regression run against a live model (`OPENAI_API_KEY`, `OPENAI_MODEL`) |

## Configuration

Copy [`server/.env.example`](server/.env.example) to `server/.env` to change anything. The defaults run
everything locally: `APP_MODE=local`, `AI_ADAPTER=dev`, `EMAIL_TRANSPORT=dev`.

* **Supabase + production:** [`docs/deployment.md`](docs/deployment.md)
* **n8n workflows:** [`n8n/README.md`](n8n/README.md)

## Project layout

```
apps/web            Vue 3 + TypeScript + Vite + Tailwind + Pinia + Vue Router
server              Node.js API (Hono): auth, validation, sanitization, n8n adapters, scheduler
packages/shared     Zod schemas, statuses, the versioned six-element prompt
supabase/migrations PostgreSQL schema, RLS policies, workflow functions
n8n                 Importable workflows A (AI), B (delivery), C (continuity), docker-compose
docs                Architecture, database, security, API, testing, deployment, capstone documents
```

## Documentation

[Architecture](docs/architecture.md) · [Database](docs/database.md) · [Security](docs/security.md) ·
[API](docs/api.md) · [Testing](docs/testing.md) · [Deployment](docs/deployment.md) ·
[Capstone documents](docs/capstone/README.md)

## Troubleshooting

* **"Can't connect" on first load** — the API is still starting; wait a few seconds and retry.
* **"The local database is in use by another process"** — another API is running; stop it first.
* **Start over** — stop the dev server and run `npm run seed -- --reset`.
