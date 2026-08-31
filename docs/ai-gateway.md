# Model + search: the Astro AI Gateway

**How NextGig runs:** the model *and* web search go through the **Astro AI
Gateway**. There is no provider API key anywhere in this project — declaring a
gateway model in `astropods.yml` makes the platform inject a managed per-tenant
credential:

```yaml
models:
  default:
    provider: gateway
    models: [gpt-5-6-luna]
```

At deploy (and under `ast project start`) that injects:

| Env var | Meaning |
| --- | --- |
| `ASTRO_GATEWAY_URL` | Gateway base URL (OpenAI-compatible API at `/v1`) |
| `ASTRO_GATEWAY_API_KEY` | Managed per-tenant credential |
| `MODEL_DEFAULT` | The model picked from `models.default.models` |

Run `ast login` first — the gateway is account-scoped.

## Model

`agent/index.ts` points `@ai-sdk/openai` at `${ASTRO_GATEWAY_URL}/v1` with the
gateway key and uses `MODEL_DEFAULT` (falling back to `gpt-5-6-luna`):

```ts
const gateway = createOpenAI({
  apiKey: process.env.ASTRO_GATEWAY_API_KEY,
  baseURL: `${process.env.ASTRO_GATEWAY_URL}/v1`,
});
model: gateway(process.env.MODEL_DEFAULT ?? 'gpt-5-6-luna')
```

The **bare `gateway(model)` call** targets the OpenAI **Responses API**
(`/v1/responses`), which is what carries provider-executed tools. Do not switch
to `gateway.chat()` (Chat Completions) — it cannot express `web_search`.

## Search: `web_search` (server-side)

`web_search` is a **provider-executed** tool: the model decides when it needs
current information, the search runs inside the gateway (Bedrock Web Search),
and the answer comes back grounded with `url_citation` annotations. Nothing runs
client-side and there is no search API key.

```ts
tools: {
  web_search: { ...gateway.tools.webSearch({ externalWebAccess: false }), id: 'openai.web_search' },
}
```

Two things to know:

- **`externalWebAccess` MUST stay `false`.** It maps to `external_web_access`,
  which defaults to **true**, and the gateway role is deliberately not granted
  `bedrock-websearch:ExternalWebAccess` — leaving the default returns a 403 on
  the authorization check. `false` serves retrieval from the Bedrock web index
  and cache, so request data stays inside the AWS boundary.
- **The explicit `id` is required.** Mastra's `ToolsInput` wants a
  `ProviderDefinedTool` carrying an `id`, which the AI SDK factory doesn't
  surface in its type. `'openai.web_search'` is the id Mastra itself uses
  (`WebSearchProviderToolId`).

Web search needs one of the GPT-5.x gateway models (`gpt-5-4`, `gpt-5-5`,
`gpt-5-6-luna`, `gpt-5-6-sol`, `gpt-5-6-terra`).

## Fetch: `web_fetch` (client-side)

Because `externalWebAccess` is `false`, `web_search`'s own `openPage` /
`findInPage` actions read from the Bedrock index and cache rather than the live
web — fine for finding postings, not enough to prove one is still open.

So live page reads are a plain client-side tool: **`web_fetch`**
(`agent/tools.ts`, backed by `agent/fetchpage.ts`). It GETs one http(s) URL from
the agent container, strips the HTML to text, and returns `status`, the final
`url` after redirects, the page `text` (truncated to 8k chars), and two verdicts.

**`postingGone`** — the role is definitely not there: HTTP 404/410, or a
high-signal "no longer accepting applications"-style phrase (`looksClosed`).

**`contentConfirmed`** — the page actually backs up the posting the model is
about to present. A 200 does not: this is the agent's main defence against
hallucinated apply links, so the tool takes `expectedTitle` / `expectedCompany`
and checks them. It is false, with a `confirmation` string explaining why, when:

| Signal | Why it matters |
| --- | --- |
| A redirect dropped the posting id (`lostPostingId`) | Boards answer an unknown or expired job id with their generic careers page. That page can be **byte-identical** to a real posting's page — it lists every open role, so even a title match succeeds. The surviving id is the only reliable discriminator. |
| Under `MIN_CONTENT_CHARS` (500) of text | Ashby and Workday render postings in the browser and serve ~4 chars to a plain GET. Nothing to check. |
| `expectedTitle` / `expectedCompany` not mentioned (`mentionsPhrase`) | Wrong page, or the expected title was wrong. Matching is tolerant: exact phrase, else ≥60% of the phrase's significant words. |
| Neither expectation passed | Nothing was checked, so nothing is confirmed. |

`contentConfirmed: false` means **unproven, not fake**. Genuine postings on
browser-rendered boards can never be confirmed this way, so the prompt tells the
model to still show them while saying it could not confirm them — and never to
call a posting "verified" without `contentConfirmed: true`. Transport failures
(`ok: false`) are likewise not treated as "closed".

The scheduler's own link check (`isLivePosting` in `agent/scheduler.ts`) uses the
same `fetchPage` helper, so chat and email digests judge a dead link identically.
It deliberately prunes on `postingGone` only — dropping everything unconfirmed
would discard every real Ashby and Workday role.

## ⚠️ `store: false` is required

The agent sets this on every call (`defaultOptions.providerOptions` in
`agent/index.ts`):

```ts
providerOptions: { openai: { store: false } }
```

Without it, **every client-side tool call fails** with:

```
400 invalid_request_error / validation_error
No tool call found for function call output with call_id call_…
```

Why: on the Responses API a client may replay earlier turns as `item_reference`
ids instead of full items, and `@ai-sdk/openai` does exactly that whenever
`store` is true — which is its default. The gateway is stateless and **silently
drops** those references (verified: referencing a previous `web_search_call` id
makes the model answer "no results in context"). For a client tool that means the
follow-up request carries a `function_call_output` whose `function_call` has
vanished, and the gateway rejects the pair.

`store: false` makes the SDK inline the real `function_call` items, and
round-trips work. Provider-executed `web_search` *results* are not replayed
either way — the model's own text summary of them is, which is what later steps
actually need.

## The agent's other tools

`save_profile`, `set_preferences`, `get_profile`, `send_digest_now`, and
`web_fetch` are ordinary client-side tools and run through the normal AI SDK
tool-use loop against the gateway. Only `web_search` executes gateway-side.

## Turns are tool-hungry: step budget + empty-reply guard

A job-search turn is several `web_search` rounds, then a `web_fetch` per
candidate, and only then the answer. Two consequences:

- **`maxSteps: 15`** in `defaultOptions`. Mastra's default budget is much
  smaller, and running out mid-loop ends the turn right after a tool call with
  **no text at all** — which the frontend could only render as an error.
- **Empty-reply recovery** in `agent/webserver.ts`. If a turn still yields no
  text, the model is asked once more on the same thread with `toolChoice: 'none'`
  ("write your reply using what you already found"), and only if that also comes
  back empty does the user see an apology. Both paths log to the server.

Observed with `gpt-5-6-luna`: intermittent, and always on the first big search of
a session. Tool inputs are also validated leniently for the same reason — the
model sends `years: "5"` where the schema wants a number, so `save_profile`
normalizes strings rather than rejecting the whole call (`normalizeSkills` in
`agent/tools.ts`).

## Progress feedback during a silent turn

`generate()` is silent for as long as a minute, so the NDJSON stream carries
`{"t":"status","v":"…"}` events alongside the 15s heartbeat, and the UI's typing
bubble shows the latest one plus an elapsed counter. Two sources:

- **Our tools report themselves** through `reportStatus` (`agent/context.ts`),
  which writes to an `onStatus` sink on the AsyncLocalStorage request context —
  so `web_fetch` can say *"Opening jobs.ashbyhq.com to check the posting…"* while
  it runs.
- **`onStepFinish`** covers the one thing our tools cannot see: the gateway's
  provider-executed `web_search`. Mastra nests the name at
  `toolCalls[].payload.toolName`, not `toolCalls[].toolName`.

## Model calls are NON-streaming

`/api/chat` calls `agent.generate()`, not `agent.stream()`, and keeps a streamed
NDJSON transport with a **15s heartbeat** (`agent/webserver.ts`) so the browser
connection survives a long search turn; the full answer is then sent as one
chunk. Trade-off: no token-by-token typing (the typing indicator covers the
wait).

This was originally *required*: search used to be a Bifrost **MCP** tool whose
auto-execution only runs on complete responses and is skipped on `chat_stream`
([docs](https://docs.getbifrost.ai/mcp/agent-mode)). That constraint is gone now
that search is a provider-executed tool, so streaming could be revisited — the
`generate()` path is kept because a server-side search returns nothing until the
grounded answer is complete anyway.

## History (why this took a while)

1. The gateway was **LiteLLM**, Bedrock-only, with no way to run search — so
   NextGig used direct Anthropic with its native `web_search`.
2. The gateway moved to **Bifrost**, which added a server-side **MCP** layer: a
   Tavily MCP server executed gateway-side gave keyless search to any model, at
   the cost of the non-streaming constraint and some agent-mode scaffolding
   leaking into replies (`agent/sanitize.ts` still cleans that).
3. Now the gateway exposes **Bedrock Web Search as a provider-executed tool** on
   the Responses API — keyless model *and* keyless search with no MCP wiring or
   virtual-key grants to maintain. That's the current setup, and the direct
   Anthropic fallback (and `@ai-sdk/anthropic`) has been removed: the gateway is
   the only path.
