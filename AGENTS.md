# job-hunter

Builds a skill matrix from a user's pasted LinkedIn profile, captures their location and notification preferences, and emails scheduled job-match digests found via web search.

## Layout

- `agent/index.ts` — entry point: Mastra agent (Anthropic model + native web search), file-backed memory, observability, starts the scheduler, starts the frontend, `serve()`.
- `agent/webserver.ts` — custom chat + PDF-upload frontend (Bun.serve on port 80). Cookie session → memory thread + subscriber id; calls `agent.generate()` in-process.
- `agent/frontend.ts` — the single-page chat UI (inlined HTML string).
- `agent/tools.ts` — onboarding/runtime tools: `save_profile`, `set_preferences`, `get_profile`, `send_digest_now`.
- `agent/scheduler.ts` — in-process node-cron loop; per due subscription, generates a digest and emails it.
- `agent/email.ts` — Resend email delivery (via fetch); `agent/settings.ts` — runtime Resend key/from stored in `./data`.
- `agent/db.ts` — file-backed LibSQL store: `subscriptions`, `sent_jobs` (de-dup), `digest_runs` (search history).
- `agent/storage.ts` — resolves the shared LibSQL db path.
- `agent/context.ts` — AsyncLocalStorage for per-conversation subscriber identity.

## Conventions

- Web search + fetch are Anthropic's native server-side tools (reuse `ANTHROPIC_API_KEY`); no jobs-API key. Fetch is used to open a listing/board and pull the direct application URL.
- LinkedIn is never scraped — the user pastes their profile text or uploads a PDF (parsed to text server-side with `unpdf`).
- The scheduler sends email deterministically (not via an LLM tool).
- The only user-facing interface is the custom frontend (port 80); the agent runs in-process (no messaging sidecar / `serve()`).

For comprehensive documentation including **critical API usage notes**, run `ast docs`.
