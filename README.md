# NextGig
Builds a skill matrix from a user's pasted LinkedIn profile (or uploaded PDF/CV), captures their location and notification preferences, and emails scheduled job-match digests found via web search.

> ### ⚠️ This is a personal (single-user) agent
>
> This blueprint is designed to be deployed **by you, for you** — one job seeker,
> one private deployment. It is intentionally simple and is **not** built for
> multi-tenant or public multi-user use:
>
> - **No authentication.** Anyone who can reach the URL can use it and see
>   whatever that browser session created. Identity is just an anonymous cookie,
>   not a login account.
> - **Email settings are deployment-global.** The Resend API key / sender set in
>   the in-app Settings panel are shared across everyone using that deployment —
>   one visitor can change the sender for all.
> - **Cost is pooled.** Every job search (your Astro AI Gateway account) and
>   every email (Resend) bills to *you*.
>
> **Deploy it privately** (keep the URL to yourself, or put it behind your
> platform's access control). If you want to run it for multiple real users, read
> [`docs/single-vs-multi-user.md`](docs/single-vs-multi-user.md) first — you'll
> need to add authentication and gate the operator settings before exposing it
> publicly.

## Quick start

```bash
# Authenticate — the AI gateway and the Postgres store are account-scoped
ast login

# Install dependencies
bun install

# Start the agent locally (agent on :3200, plus a Postgres sidecar)
ast project start
```

Then deploy it:

```bash
ast push --visibility public
ast deploy nextgig --wait
```

## Project structure

```
nextgig/
├── agent/
│   ├── index.ts          # Agent entry point (gateway model + web_search, scheduler, frontend)
│   ├── webserver.ts      # custom chat + PDF-upload frontend (Bun.serve on port 80)
│   ├── frontend.ts       # single-page chat UI (inlined HTML)
│   ├── tools.ts          # save_profile / set_preferences / get_profile / send_digest_now /
│   │                     #   web_fetch / mark_applied / list_applications
│   ├── fetchpage.ts      # shared live page fetch (web_fetch tool + link verification)
│   ├── scheduler.ts      # in-process node-cron digest loop
│   ├── email.ts          # Resend email delivery (via fetch)
│   ├── settings.ts       # runtime settings (Resend key/from) in the settings table
│   ├── db.ts             # Postgres store (subscriptions, sent_jobs, applications, …)
│   ├── storage.ts        # Postgres connection settings + shared pool
│   └── context.ts        # per-conversation subscriber identity
├── astropods.yml         # Agent specification
├── Dockerfile            # Agent container
├── .env                  # Environment variables (set via ast configure; not committed)
└── package.json
```

## How it works

1. **Onboarding (chat or PDF):** the user pastes their LinkedIn profile / resume **or uploads a PDF** (LinkedIn "Save to PDF" export, or a CV). Uploaded PDFs are parsed to text server-side (`unpdf`) and fed to the agent like a paste. The agent extracts a structured skill matrix, then asks for location (city, country, remote preference) and notification settings (email + daily/weekly cadence).
2. **Scheduled digests:** an in-process scheduler wakes hourly, finds subscriptions whose cadence has elapsed, searches the web for matching open roles, **de-duplicates against everything already emailed to that subscriber, verifies each candidate link is a live posting (drops 404/expired/filled pages), and emails only the new, live roles** via Resend (skipping the email entirely when nothing is new). Link verification is conservative — network errors / bot-blocks are kept, never over-pruned — and can be disabled with `NEXTGIG_VERIFY_LINKS=0`. Every run is logged to the `digest_runs` table.
3. **On demand:** "send me one now" runs an immediate search and email; the agent can also discuss matches directly in chat.
4. **Application tracking:** tell it when you apply ("I applied to the Wolt one") and it files the posting; report outcomes ("I have an interview", "they rejected me") and it updates the status. Ask "what have I applied to?" for a dated list, and applied roles never come back in a digest.

LinkedIn is never scraped — the user pastes their profile. The **model and web
search both run through the Astro AI Gateway** (no provider key to bring); see
[`docs/ai-gateway.md`](docs/ai-gateway.md).

## Configuration

The agent is configured in `astropods.yml`. Key sections:

### Integrations

| Integration | Type | Environment variable | Required |
|------------|------|---------------------|----------|
| Astro AI Gateway | Model + server-side web search | `ASTRO_GATEWAY_URL`, `ASTRO_GATEWAY_API_KEY`, `MODEL_DEFAULT` (all injected by the `models.default` gateway block) | yes |
| Resend | Email delivery | `RESEND_API_KEY` | for notifications |
| Resend (optional) | From address | `RESEND_FROM` | no (defaults to `onboarding@resend.dev`) |

**Model + search:** declaring a gateway model gives the agent a managed
per-tenant credential — no provider API key anywhere in this project:

```yaml
models:
  default:
    provider: gateway
    models: [gpt-5-6-luna]
```

The model runs on the gateway's OpenAI-compatible endpoint (Responses API) and
`web_search` is a **provider-executed** tool: the model asks, the gateway runs
the search (Bedrock Web Search) and returns a grounded, cited answer. A
client-side `web_fetch` tool opens individual posting URLs to pull the direct
apply link and to check the page really is that posting (guarding against
hallucinated links and expired job ids). Run `ast login` first — the gateway
is account-scoped. Details in [`docs/ai-gateway.md`](docs/ai-gateway.md).

### Email (Resend) setup

Email goes through [Resend](https://resend.com) — one API key, no SMTP, no app
passwords, no 2FA, and unaffected by Google Workspace policies. Two ways to set it:

- **In-app (easiest):** open the **⚙ Settings** panel (top-right of the frontend),
  paste your Resend API key, optionally set a From address, and hit **Save & send
  test**. Stored in the `settings` table.
- **Server secret (production):** set `RESEND_API_KEY` via `ast secrets` /
  `ast project configure`. This **takes precedence** over the in-app value.

`RESEND_FROM` defaults to `NextGig <onboarding@resend.dev>`. Until you verify a
domain in Resend, that default sender can only email your own Resend account
address — verify a domain (or set `RESEND_FROM`) to email arbitrary recipients.

Without a key, onboarding and in-chat job search still work — only scheduled
emails are skipped.

> Note: the in-app Settings endpoints are not auth-gated. For a publicly exposed
> deployment, prefer the `RESEND_API_KEY` secret over the in-app field.

### Data & persistence

All state lives in a **Postgres knowledge store deployed with the agent**,
declared in `astropods.yml`:

```yaml
knowledge:
  db:
    provider: postgres
```

Provider-mode knowledge entries always get a persistent volume, so the data
survives restarts *and* redeploys. The platform generates a managed user and a
random password and injects `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`, and `POSTGRES_DB`; `agent/storage.ts` reads all five and
owns the shared connection pool. Tables (created on first use by `agent/db.ts`):

- `subscriptions` — skill matrix, location, cadence, email, and `last_run_at`
- `sent_jobs` — per-subscriber fingerprints of already-emailed roles (de-dup)
- `applications` — postings the user applied to, with status and notes
- `digest_runs` — history of every scheduled/on-demand search
- `settings` — runtime config (e.g. the in-app Resend key)
- Mastra conversation memory (`mastra_*`, via `@mastra/pg`)

Because the schedule's `last_run_at` is persisted, a **restart or redeploy
resumes cleanly** — no lost cadence, no re-blast, and no lost profile or
application history. The agent's own container filesystem is *not* durable (the
spec has no volume option for the agent), which is exactly why nothing is stored
there.

### Interfaces
- **Custom frontend** — chat UI with PDF upload, served on port 80 by the agent process (`agent/webserver.ts`). This is the only user-facing interface; the agent is driven in-process via `agent.generate()` (no messaging sidecar).

