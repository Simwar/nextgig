# Model + search: the Astro AI Gateway

**How NextGig runs:** the model *and* web search go through the **Astro AI
Gateway** (Bifrost). No provider key to bring — `agent.astro_ai_gateway: true`
injects a managed per-tenant key (`ASTRO_GATEWAY_URL` + `ASTRO_GATEWAY_API_KEY`).

## Model
The gateway exposes an **OpenAI-compatible** endpoint. The agent points
`@ai-sdk/openai` at `${ASTRO_GATEWAY_URL}/v1` with the gateway key
(`agent/index.ts` → `selectModel()`), using model id `claude-opus-4-8`
(Bedrock-backed via the gateway's IRSA — no key custody on our side).

## Search
Web search is the gateway's **server-side MCP tool** (a **Tavily** MCP server
configured in Bifrost). Bifrost injects the `tavily_*` tools into the request
and **executes them gateway-side**, returning the grounded answer — so the agent
declares **no** search tool client-side. Anthropic's native `web_search` is *not*
used on this path (the gateway is Bedrock-backed and doesn't expose Anthropic
server-side tools).

The agent's custom tools (`save_profile`, `set_preferences`, …) are ordinary
client-side tools and run through the gateway's normal (OpenAI-compat)
client-tool-use loop; only the `tavily_*` search tools are executed gateway-side.

### Model calls must be NON-streaming
Bifrost's MCP **agent mode** (auto-execution of `tavily_*`) only runs on complete
responses — it is **incompatible with streaming** (`chat_stream`), which silently
skips the tool loop and returns a bare `tool_calls` the client can't run. So the
agent calls the model with **`agent.generate()`** (non-streaming), not
`agent.stream()`. To still avoid the browser idle-timeout on long search turns,
`/api/chat` keeps a **streamed NDJSON transport with a 15s heartbeat**
(`agent/webserver.ts`): the heartbeat holds the browser connection open while
`generate()` runs, then the full answer is sent as one chunk. Trade-off: no
token-by-token typing in the UI (the typing indicator covers the wait).
Ref: https://docs.getbifrost.ai/mcp/agent-mode

### ⚠️ Required gateway setup (Bifrost)
- The **Tavily MCP server** must be registered in Bifrost with a `tavily_search`
  (and related) tool.
- The **deployment's virtual key must be granted access to that MCP server**
  ("Virtual Key Access" in the Bifrost admin). Without it, Bifrost injects no
  search tools and the agent silently has no search.

## Direct-Anthropic fallback (local dev)
If the gateway env vars are absent (e.g. running `bun agent/index.ts` locally
without `ast dev`), the agent falls back to **direct Anthropic**: set
`ANTHROPIC_API_KEY` and it uses Anthropic's native server-side `web_search`
tool. `ast dev` injects the gateway vars, so dev normally uses the gateway too.

## Prompts are capability-oriented
Instructions and the digest prompt say "use the available web search tool"
rather than naming a specific tool id — so the same prompt works whether the
injected tool is `tavily_search` (gateway) or `web_search` (direct fallback).

## History (why this took a while)
Earlier the gateway was LiteLLM and Bedrock-only with no way to run search, so
NextGig used direct Anthropic. Switching the gateway to **Bifrost** added a
server-side **MCP** tool layer: Bedrock models can't run Anthropic's own server
tools, but Bifrost can host an MCP search server (Tavily) and execute it
gateway-side for any model. That's what makes keyless model + keyless search
possible here.
