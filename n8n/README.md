# n8n integration (self-hosted Community Edition)

> **Status:** these workflows are importable exports written for n8n 1.x. They have **not yet been run
> against a live n8n instance** in this repository. The API side of the contract (webhook payloads,
> callback authentication, schema validation, idempotency, retries) is covered by automated tests that
> simulate n8n — see `server/test/integrations.test.ts`.

| Workflow | File | Triggered by | Does |
|---|---|---|---|
| A. AI report processing | `workflows/A-ai-report-processing.json` | API, after a valid submission | Calls the model with the six-element prompt; returns raw output to the API |
| B. Approved handover delivery | `workflows/B-approval-delivery.json` | API, when emails are queued (approvals, review requests, …) | Sends each email with Resend; reports each result |
| C. Continuity checks | `workflows/C-continuity-scheduled-checks.json` | Schedule (5 min) | Asks the API to run timeouts, escalations, missing-report alerts, retention |

SMS is optional and provider-neutral. Configure a separate n8n webhook that accepts the SMS contract
below, sends through your chosen provider node, and posts each result to the existing delivery callback.

n8n never writes to the database and never approves anything. It only reports results for work the API
dispatched; the API accepts a result only if the event id **and** attempt number match what it sent.

## 1. Run n8n

```bash
cd n8n
cp .env.example .env   # set N8N_ENCRYPTION_KEY and the public URL
docker compose up -d
```

Put n8n behind HTTPS (a reverse proxy or your host's TLS). The API refuses non-HTTPS webhook URLs when
`NODE_ENV=production`.

## 2. Create credentials in n8n

| Credential (type) | Name used in the workflows | Value |
|---|---|---|
| Header Auth | Silent Handover — inbound webhook secret | Name `X-Silent-Handover-Secret`, value = API's `N8N_WEBHOOK_SECRET` |
| Header Auth | Silent Handover — callback bearer | Name `Authorization`, value = `Bearer ` + API's `N8N_CALLBACK_SECRET` |
| OpenAI API | OpenAI account | Your OpenAI key (Workflow A) |
| Header Auth | Resend API key | Name `Authorization`, value = `Bearer re_…` (Workflow B) |

Generate the two shared secrets with `openssl rand -base64 36` (at least 24 characters each).

## 3. Import and configure

1. **Workflows → Import from file**, once per JSON file.
2. Open each workflow and re-select the credentials (imports keep only the names).
3. In **A → Prepare** set `API_BASE_URL` and `MODEL` (a model that supports JSON-schema structured output).
4. In **B → One item per email** set `API_BASE_URL`.
5. In **C → Run checks in API** set the URL.
6. Activate A and B. Activate C only if the API runs with `ENABLE_INTERNAL_SCHEDULER=false`.

## 4. Point the API at n8n

```dotenv
AI_ADAPTER=n8n
EMAIL_TRANSPORT=n8n
N8N_ANALYSIS_WEBHOOK_URL=https://n8n.example.com/webhook/silent-handover-analysis
N8N_DELIVERY_WEBHOOK_URL=https://n8n.example.com/webhook/silent-handover-delivery
SMS_TRANSPORT=n8n
N8N_SMS_WEBHOOK_URL=https://n8n.example.com/webhook/silent-handover-sms
SMS_FROM=Silent Handover
N8N_WEBHOOK_SECRET=...
N8N_CALLBACK_SECRET=...
```

Restart the API. The admin **Integrations** page then shows "n8n workflow" instead of "Development simulator".

### Optional SMS workflow contract

The SMS webhook receives `{ deliveries, from, callback_url }`. Each delivery contains
`delivery_id`, `attempt`, `channel: "sms"`, `to`, `text`, and `idempotency_key`. Authenticate the
webhook with the same `X-Silent-Handover-Secret` credential, use `idempotency_key` with the provider
when supported, and post `{ results: [{ delivery_id, attempt, status, provider, provider_message_id?, error? }] }`
to the fixed `/api/integrations/n8n/delivery-result` URL using the callback bearer credential. Do not
use a callback URL supplied by an untrusted client.

## 5. Verify before using real data

1. Submit a test report with the synthetic sample (demo mode) and watch the n8n execution log.
2. On the admin Integrations page the `report_analysis` event should reach **completed**; the review page
   should show the model name and prompt version instead of the "Simulated draft" banner.
3. Approve it and check that Resend shows the emails, and that deliveries show **sent** with message ids.
4. Turn off the OpenAI credential to confirm the failure path: the event retries with backoff and, after
   `ai_max_attempts`, the report goes to the supervisor as "Manual review required".
5. Record the results in `docs/testing.md` (pending rows) and run `npm run prompt:eval` for the prompt.

## Using Gemini instead of OpenAI

Replace the **Generative AI** node's request with Gemini's `generateContent` endpoint, put
`system_prompt` in `systemInstruction`, `user_prompt` in `contents`, set
`generationConfig.responseMimeType = "application/json"` and `responseSchema` to the provided schema, and
in **Result** read `candidates[0].content.parts[0].text`. The API side does not change.

## Data processing

Only sanitized text reaches n8n and the model provider (names replaced by pseudonyms; contact details,
government IDs and medical terms removed). Workflow settings above disable saving successful execution
data so prompts are not retained in n8n's database. Check your provider's retention terms before using real
workplace data — disabling training is not the same as zero retention (see `docs/capstone/05-pii-sanitization-matrix.md`).
