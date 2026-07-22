---
description: "A personal job-hunting agent that turns your LinkedIn/CV into a skill matrix and emails you new, verified job matches."
tags: ["jobs", "job-search", "linkedin", "cv", "email-digest", "notifications", "web-search", "personal-agent"]
authors:
  - name: "Simon Guerrier"
    account: "simon"
repository: "github:Simwar/nextgig"
capabilities:
  - "Extract a structured skill matrix from a pasted LinkedIn profile or uploaded PDF/CV"
  - "Capture target location and remote (remote/hybrid/onsite) preferences"
  - "Search the web for currently-open job postings matching the candidate"
  - "Verify each posting link is live before sending (drops 404/expired/filled pages)"
  - "Email daily or weekly job-match digests via Resend, de-duplicated across runs"
  - "Search and preview matches on demand from the chat UI"
integrations:
  - "Astro AI Gateway"
  - "Resend"
---

# NextGig

Job hunting means running the same searches over and over, re-reading listings you've already seen, and clicking through to postings that turned out to be filled last week. NextGig does that loop for you: hand it your LinkedIn profile or CV once, and it emails you a short digest of **new, still-open** roles that match your skills and location — nothing you've already been shown.

> **Personal (single-user) agent.** Deploy it by yourself, for yourself, and keep the deployment private. It has no authentication, its email settings are shared per deployment, and all model/email usage bills to your keys — so it is not built for multi-tenant or public multi-user use as-is. See [`docs/single-vs-multi-user.md`](docs/single-vs-multi-user.md) for what running it for multiple users would take.

## Overview

NextGig is a chat agent with a small web frontend. Onboarding is conversational and takes about a minute:

1. **Profile → skill matrix.** Upload your LinkedIn profile saved as a PDF (LinkedIn → More → Save to PDF) or your CV, or just paste the text. The agent extracts your headline, target job titles, and a skill list with proficiency levels. PDFs are parsed to text server-side — LinkedIn is never scraped.
2. **Location & preferences.** It asks where you want to work (city, country) and whether you want remote, hybrid, onsite, or any.
3. **Notifications.** Opt in with your email and a cadence (daily or weekly).

From then on, a built-in scheduler does the hunting:

- **Finds matches** via the Astro AI Gateway's server-side web search (Tavily MCP), biased toward real postings on applicant-tracking systems (Greenhouse, Lever, Ashby) and company career pages rather than aggregator homepages.
- **De-duplicates** against everything already emailed to you, so a digest never repeats a role you've seen.
- **Verifies links are live** — each candidate URL is opened and dropped if it 404s or the page says the role is expired/filled (conservative: network errors and bot-blocks are kept, never over-pruned).
- **Emails only what's new**, and skips the email entirely when there's nothing new to send.

## Usage

- **Onboard:** open the frontend, upload your CV/LinkedIn PDF (or drag-and-drop it anywhere on the page), and answer the two follow-up questions.
- **Get matches now:** *"Send me matches now"* runs an immediate search and emails the digest. *"What roles are out there for me today?"* discusses matches directly in chat.
- **Adjust anything:** *"Change my location to Berlin, remote only"* or *"Switch me to weekly emails"* updates your saved preferences.
- **Enable email:** click the gear icon (top-right) → paste a free [Resend](https://resend.com) API key → **Save & send test**. Or set `RESEND_API_KEY` as a deployment secret (that takes precedence).

Everything except the scheduled emails works without any email setup — you can onboard and browse matches in chat immediately.

### Configuration

| Variable | Purpose | Required |
|---|---|---|
| `ASTRO_GATEWAY_URL` / `ASTRO_GATEWAY_API_KEY` | Model + web search via the gateway (injected by `astro_ai_gateway: true`) | Yes |
| `ANTHROPIC_API_KEY` | Fallback model + native web search (local dev without the gateway) | No |
| `RESEND_API_KEY` | Email delivery (or set it in-app via the Settings panel) | For email digests |
| `RESEND_FROM` | Sender address; defaults to `onboarding@resend.dev` | No |

## Limitations

- **Personal use only** — no authentication or per-user accounts; email settings are shared per deployment. Keep it private (see the note above).
- **Link verification can't see behind bot walls.** Sites like LinkedIn/Indeed often block server-side fetches, so postings there are kept as "uncertain" rather than verified — hence the bias toward checkable ATS/careers pages.
- **Job data quality depends on web search.** The agent only reports postings it actually found and never fabricates URLs, but freshness and coverage vary by market and search results.
- **Scanned/image-only PDFs** can't be parsed — use a text-based export or paste your profile.
- **Persistence needs a volume.** State lives in a file-backed database under `./data`; mount a persistent volume there (or use a managed store) so a full redeploy doesn't reset subscriptions and history.
