# Deployment

> Nothing has been deployed from this repository yet. These are the intended steps; each is
> **not yet verified** against live services (see `docs/testing.md`, "Pending").

```
Browser ──HTTPS──▶ Web (Vercel, static)            Supabase: Auth + PostgreSQL (RLS)
   │                                                  ▲
   └──HTTPS /api──▶ API (Node container) ─────────────┘
                        │   ▲
            webhook+secret  callback+secret
                        ▼   │
                    n8n (self-hosted, HTTPS) ──▶ OpenAI / Resend
```

## 1. Supabase

1. Create a project. In **Authentication → Providers** keep Email enabled; disable public sign-ups
   (accounts are created by administrators).
2. Apply the migrations, either with the Supabase CLI (`supabase link` then `supabase db push`) or with
   the API's script: set `APP_MODE=supabase` and `DATABASE_URL` (pooler URL, `postgres` role), then
   `npm run build -w server && node server/dist/scripts/migrate.js`.
3. Create the first administrator: create a user in **Authentication → Users**, then in the SQL editor:
   `insert into public.profiles (id, full_name, email, role) values ('<auth user id>', 'Name', 'email', 'admin');`
   Everything else (departments, shifts, users) is done in the admin portal.
4. Do not expose the `app` or `internal` schemas in **API settings → Exposed schemas** (only `public`).

## 2. API

Build the container from the repository root:

```bash
docker build -f server/Dockerfile -t silent-handover-api .
```

Run it on any container host (Render, Railway, Fly.io, a VM) with environment variables from
`server/.env.example`:

```dotenv
NODE_ENV=production
APP_MODE=supabase
DATABASE_URL=...
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
APP_BASE_URL=https://handover.example.com
PUBLIC_API_URL=https://api.handover.example.com
CORS_ORIGINS=https://handover.example.com
AI_ADAPTER=n8n
EMAIL_TRANSPORT=n8n
N8N_ANALYSIS_WEBHOOK_URL=https://n8n.example.com/webhook/silent-handover-analysis
N8N_DELIVERY_WEBHOOK_URL=https://n8n.example.com/webhook/silent-handover-delivery
N8N_WEBHOOK_SECRET=...
N8N_CALLBACK_SECRET=...
```

The API refuses to start in production with local mode or non-HTTPS webhooks. Keep
`ENABLE_INTERNAL_SCHEDULER=true` on a long-running host; on serverless set it to `false` and activate
n8n Workflow C.

## 3. Web

On Vercel, import the repository and set **Root Directory** to `apps/web` (the included `vercel.json`
builds the workspace and rewrites routes to `index.html`). Set `VITE_API_URL` to the API's public URL.

## 4. n8n

Follow `n8n/README.md`. Run the verification checklist there before any real data is used.

## 5. Before real workplace data

* Confirm the AI provider's data-processing and retention terms in writing (see
  `docs/capstone/05-pii-sanitization-matrix.md`).
* Record the prompt regression run (`npm run prompt:eval`) for the prompt version you deploy.
* Review `pii_retention_days`, `ai_timeout_minutes`, `escalation_hours` in admin **Settings**.
* Set `DEMO_MODE=false`.
