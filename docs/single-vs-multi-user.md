# Personal vs. multi-user: the trade-off

NextGig can run in two modes. This is the decision and what each mode costs.

Today the agent is **effectively single-user-safe but multi-user-capable-by-accident**:
data is already keyed per browser session (see below), but there is **no login,
no auth, and shared operator settings** — which is fine for one user and risky
for many. Pick a lane before deploying for other people.

## TL;DR

| | Personal (one user ever) | Multi-user |
|---|---|---|
| Who uses it | Just you | Anyone with the URL / your users |
| Auth | None needed | **Required** (accounts or an access gate) |
| Identity today | Cookie `jh_session` per browser | Same cookie — **not** a real account |
| Email sender (Resend) | Yours, set once | **Shared by everyone** unless gated |
| Settings panel (gear) | Fine to expose | **Must be operator-only** |
| Data isolation | N/A (one person) | Already per-`sessionId`, but spoofable |
| Cost/complexity | Ship as-is | Auth + per-user secrets + abuse controls |
| Web-search / email cost | You pay, you control | **You pay for every user's searches & emails** |

## What already works per-user (regardless of mode)

The custom frontend assigns each browser a `jh_session` cookie, and that id keys:

- the **subscription** (skill matrix, location, cadence, email),
- **chat memory** (Mastra thread + resource = the session id),
- **sent-jobs de-dup** and **digest history** (`sub_id`).

So two browsers already get separate profiles and separate job history. That is
necessary but **not sufficient** for real multi-user.

## What is shared / global (the multi-user risks)

1. **Resend email config is deployment-global.** `resend_api_key` / `resend_from`
   live in the `settings` table with no per-user scoping. Any visitor who opens
   the gear panel can read status and **change the sender for everyone**, and all
   users' digests send from that one account.
2. **No authentication.** `jh_session` is an anonymous cookie, not a login.
   Clearing cookies = a brand-new identity; there is nothing stopping someone
   from being handed (or guessing) another session id. Fine for personal use,
   unacceptable for real users' data.
3. **The Settings endpoints are ungated** (`/api/email-config`, `/api/email-test`).
4. **Cost is pooled.** Every user's job searches (Anthropic web search) and
   emails (Resend) bill to your keys. One heavy or malicious user affects all.
5. **Scheduler fan-out.** The hourly tick already loops over *all* active
   subscriptions, so multi-user scheduling works — but it also means cost and
   rate-limit pressure scale with the number of users.

## Personal mode — recommended if it's just you

Ship as-is. To make the "single-user" assumption explicit and safe:

- Keep the deployment private (don't share the URL) **or** put the whole app
  behind a platform-level access control / basic auth.
- The global Resend setting is a feature here: set it once in the gear panel.
- Nothing else to build.

Effort: **none.** This is the current state.

## Multi-user mode — what it takes

Do these before exposing it to other people (roughly in priority order):

1. **Gate operator settings.** Move email config out of the end-user UI: require
   an operator token (or set `RESEND_API_KEY` only via `ast secrets`, and remove
   the in-app key field). Small change; removes the sharpest risk.
2. **Real authentication.** Replace the anonymous cookie with actual accounts
   (email magic-link, OAuth, or a platform-provided auth). Key all data by the
   authenticated user id instead of `sessionId`.
3. **Per-user cost controls.** Rate-limit searches/digests per user; cap active
   subscriptions; consider per-user quotas.
4. **Decide the email model.** Either keep one shared sender (simplest, but every
   digest comes "from" you) or verify a domain and send per-user `reply-to`.
5. **Abuse & privacy.** Uploaded PDFs and profiles are personal data — add
   retention/delete controls and make sure one user can never see another's data
   (audit every `currentSubscriberId()` call site).

Effort: **meaningful** — auth is the bulk of it. Everything else is incremental.

## Recommendation

- **If this is your personal job hunt:** stay in personal mode. It's done; just
  keep the URL private or behind platform auth.
- **If you want others to use it:** at minimum do step 1 (gate settings) + step 2
  (auth) before sharing. Don't expose the current build publicly as-is —
  shared email settings + no auth is the combination to avoid.
