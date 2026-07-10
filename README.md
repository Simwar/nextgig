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
> - **Cost is pooled.** Every job search (Anthropic) and every email (Resend)
>   bills to *your* keys.
>
> **Deploy it privately** (keep the URL to yourself, or put it behind your
> platform's access control). If you want to run it for multiple real users, read
> [`docs/single-vs-multi-user.md`](docs/single-vs-multi-user.md) first — you'll
> need to add authentication and gate the operator settings before exposing it
> publicly.

## Quick start

```bash
# Install dependencies
bun install

# Start the agent locally
ast dev
```

## Project structure

```
nextgig/
├── agent/
│   ├── index.ts          # Agent entry point (model + web search, scheduler, frontend, serve)
│   ├── webserver.ts      # custom chat + PDF-upload frontend (Bun.serve on port 80)
│   ├── frontend.ts       # single-page chat UI (inlined HTML)
│   ├── tools.ts          # save_profile / set_preferences / get_profile / send_digest_now
│   ├── scheduler.ts      # in-process node-cron digest loop
│   ├── email.ts          # Resend email delivery (via fetch)
│   ├── settings.ts       # runtime settings (Resend key/from) in ./data
│   ├── db.ts             # file-backed LibSQL subscription store
│   ├── storage.ts        # shared db path resolution
│   └── context.ts        # per-conversation subscriber identity
├── astropods.yml         # Agent specification
├── Dockerfile            # Agent container (pre-creates writable ./data)
├── .env                  # Environment variables (set via ast configure; not committed)
└── package.json
```

## How it works

1. **Onboarding (chat or PDF):** the user pastes their LinkedIn profile / resume **or uploads a PDF** (LinkedIn "Save to PDF" export, or a CV). Uploaded PDFs are parsed to text server-side (`unpdf`) and fed to the agent like a paste. The agent extracts a structured skill matrix, then asks for location (city, country, remote preference) and notification settings (email + daily/weekly cadence).
2. **Scheduled digests:** an in-process scheduler wakes hourly, finds subscriptions whose cadence has elapsed, searches the web for matching open roles, **de-duplicates against everything already emailed to that subscriber, verifies each candidate link is a live posting (drops 404/expired/filled pages), and emails only the new, live roles** via Resend (skipping the email entirely when nothing is new). Link verification is conservative — network errors / bot-blocks are kept, never over-pruned — and can be disabled with `NEXTGIG_VERIFY_LINKS=0`. Every run is logged to the `digest_runs` table.
3. **On demand:** "send me one now" runs an immediate search and email; the agent can also discuss matches directly in chat.

LinkedIn is never scraped — the user pastes their profile. Job search uses Anthropic's **native web search** (reuses `ANTHROPIC_API_KEY`, no jobs-API key).

## Configuration

The agent is configured in `astropods.yml`. Key sections:

### Integrations

| Integration | Type | Environment variable | Required |
|------------|------|---------------------|----------|
| Anthropic | Model API + web search & fetch | `ANTHROPIC_API_KEY` | yes |
| Resend | Email delivery | `RESEND_API_KEY` | for notifications |
| Resend (optional) | From address | `RESEND_FROM` | no (defaults to `onboarding@resend.dev`) |

### Email (Resend) setup

Email goes through [Resend](https://resend.com) — one API key, no SMTP, no app
passwords, no 2FA, and unaffected by Google Workspace policies. Two ways to set it:

- **In-app (easiest):** open the **⚙ Settings** panel (top-right of the frontend),
  paste your Resend API key, optionally set a From address, and hit **Save & send
  test**. Stored in the writable `./data` db.
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

All state lives in one file-backed LibSQL database at `./data/nextgig.db`
(`agent/storage.ts`), separate from the app code:

- `subscriptions` — skill matrix, location, cadence, email, and `last_run_at`
- `sent_jobs` — per-subscriber fingerprints of already-emailed roles (de-dup)
- `digest_runs` — history of every scheduled/on-demand search
- `settings` — runtime config (e.g. the in-app Resend key)
- Mastra conversation memory

Because the schedule's `last_run_at` is persisted, a **process/container restart
resumes cleanly** — no lost cadence, no re-blast. ⚠️ `./data` must be a
**persistent volume** to survive a full redeploy/fresh container; the Dockerfile
pre-creates the dir but doesn't guarantee a volume. For durable production
persistence, mount a volume at `./data` or switch the store to a managed
`knowledge` provider (e.g. Postgres).

### Interfaces
- **Custom frontend** — chat UI with PDF upload, served on port 80 by the agent process (`agent/webserver.ts`). This is the only user-facing interface; the agent is driven in-process via `agent.generate()` (no messaging sidecar).

