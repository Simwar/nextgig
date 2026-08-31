# NextGig
Builds a skill matrix from a user's pasted LinkedIn profile, captures their location and notification preferences, and emails scheduled job-match digests found via web search.

## Layout

- `agent/index.ts` — entry point: Mastra agent (Astro AI Gateway model + server-side `web_search`), file-backed memory, observability, starts the scheduler, starts the frontend.
- `agent/webserver.ts` — custom chat + PDF-upload frontend (Bun.serve on port 80). Cookie session → memory thread + subscriber id; calls `agent.generate()` in-process.
- `agent/frontend.ts` — the single-page chat UI (inlined HTML string).
- `agent/tools.ts` — client-side tools: `save_profile`, `set_preferences`, `get_profile`, `send_digest_now`, `web_fetch`, `mark_applied`, `list_applications`.
- `agent/fetchpage.ts` — shared live page fetch + closed-posting detection, used by `web_fetch` and the scheduler's link check.
- `agent/scheduler.ts` — in-process node-cron loop; per due subscription, generates a digest and emails it.
- `agent/email.ts` — Resend email delivery (via fetch); `agent/settings.ts` — runtime Resend key/from stored in the `settings` table.
- `agent/db.ts` — Postgres store (schema created on first use): `subscriptions`, `sent_jobs` (de-dup), `applications` (what the user applied to), `digest_runs` (search history). `jobFingerprint`/`normalizeUrl` live here so a posting has one identity across de-dup and applications.
- `agent/storage.ts` — Postgres connection settings + the shared `pg` pool, from the platform-injected `POSTGRES_*` vars.
- `agent/context.ts` — AsyncLocalStorage for per-conversation subscriber identity.

## Conventions

- Every model call sets `providerOptions: { openai: { store: false } }` (`defaultOptions` in `agent/index.ts`). The gateway does not resolve Responses-API `item_reference` ids, so with the AI SDK default (`store: true`) every client-side tool call fails with `400 … No tool call found for function call output`.
- Model + search run through the **Astro AI Gateway** — no provider API key (`models.default.provider: gateway` in `astropods.yml`). `web_search` executes gateway-side; `web_fetch` is our own client-side tool that opens a posting, pulls the direct application URL, and reports `postingGone` (404/410 or closed-phrase) plus `contentConfirmed` (expected title/company present, posting id survived any redirect, page not a JS shell) — a 200 alone proves nothing. See `docs/ai-gateway.md`.
- The agent runs `maxSteps: 15` and the frontend recovers an empty reply with a `toolChoice: 'none'` retry — a long search sweep otherwise ends after a tool call with no text, which the UI can only show as an error.
- Long turns are silent, so progress is streamed as `{"t":"status"}` events: tools call `reportStatus` (`agent/context.ts`), and `onStepFinish` covers the gateway-side `web_search`. The typing bubble shows the latest status plus elapsed seconds.
- Tool input schemas are lenient where the model is loose (e.g. `years: "5"` is normalized, not rejected).
- LinkedIn is never scraped — the user pastes their profile text or uploads a PDF (parsed to text server-side with `unpdf`).
- The scheduler sends email deterministically (not via an LLM tool). It also excludes applied postings from digests — both by fingerprint and by listing them in the prompt.
- Applications are keyed by normalized URL (falling back to title|company), so re-recording the same posting updates it: `appliedAt` and the originally-shown URL are preserved, status/notes are not duplicated.
- The only user-facing interface is the custom frontend (port 80); the agent runs in-process (no messaging sidecar / `serve()`).

For comprehensive documentation including **critical API usage notes**, run `ast docs`.
