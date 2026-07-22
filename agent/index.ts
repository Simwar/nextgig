/**
 * nextgig - Builds a skill matrix from a user's pasted LinkedIn profile,
 * captures their location and notification preferences, and emails scheduled
 * job-match digests found via web search.
 *
 * This agent uses Mastra's Agent class with the Astro adapter to connect
 * to the Astro messaging service via gRPC.
 *
 * Environment variables (automatically injected by 'astro dev'):
 *   ANTHROPIC_API_KEY - injected by anthropic model; also powers web search
 *   GRPC_SERVER_ADDR  - injected by Astro messaging service
 *   SMTP_USER/SMTP_PASS/SMTP_HOST/SMTP_PORT/SMTP_FROM - email delivery
 */

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { anthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { dbUrl } from './storage';
import { tools } from './tools';
import { initScheduler } from './scheduler';
import { startFrontend } from './webserver';

// File-backed storage so the skill matrix, preferences, and agent memory
// survive restarts and are visible to the scheduler. Falls back to in-memory
// only when NEXTGIG_IN_MEMORY=1.
const memory = new Memory({
  storage: new LibSQLStore({
    id: 'memory',
    url: dbUrl(),
  }),
});

function resolveOtlpTracesEndpoint(): string {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/v1/traces';
    }
    return url.toString();
  } catch {
    return `${raw.replace(/\/+$/, '')}/v1/traces`;
  }
}

const observability = new Observability({
  configs: {
    otel: {
      serviceName: 'nextgig',
      exporters: [
        new OtelExporter({
          provider: {
            custom: {
              endpoint: resolveOtlpTracesEndpoint(),
              protocol: 'http/protobuf',
            },
          },
        }),
      ],
    },
  },
});

const INSTRUCTIONS = `You are NextGig, an assistant that finds job postings matching a user's skills and location, and emails them regular digests.

Onboard a new user in this order, one step at a time, conversationally:

1. SKILL MATRIX. The user provides their profile either by pasting the text of their LinkedIn profile / resume, or by uploading a PDF (its extracted text will be given to you inside <<<PROFILE ... PROFILE>>> markers). Do NOT ask for a LinkedIn URL to fetch — you cannot scrape LinkedIn. From whatever text you receive, extract a structured skill matrix: their headline, the job titles they should target, and a list of skills with proficiency levels (expert/advanced/intermediate/beginner) and years where inferable. Call the save_profile tool with this. Briefly summarize what you captured and let them correct it. If you have not received any profile yet, invite them to paste it or upload a PDF/CV.

2. LOCATION. Ask where they want to work: city, country, and whether they want remote, hybrid, onsite, or any. Save it with set_preferences.

3. NOTIFICATIONS. Ask if they'd like regular email digests of matching jobs. If yes, collect their email address and preferred cadence (daily or weekly). Call set_preferences with the email, cadence, and active=true. If they decline, call set_preferences with active=false.

After onboarding, you can:
- Run an immediate search and email it with send_digest_now (e.g. "send me one now" or to preview). Scheduled and on-demand digests only include NEW roles the user hasn't been emailed before, so if send_digest_now reports no new matches, tell the user their last digest already covered what's currently out there and you'll email as soon as fresh roles appear.
- Search and discuss matching jobs directly in chat using the available web search tool, applying the saved skills and location.
- Update any saved detail when the user asks (re-call save_profile or set_preferences).

Finding jobs — and DIRECT application links (important):
- Use the available web search tool to find candidate postings that match the target titles, skills, location, and remote preference. Prefer recent, currently-open roles.
- Bias searches toward individual postings on applicant-tracking systems, which have direct apply links — e.g. add terms like site:boards.greenhouse.io, site:jobs.lever.co, site:jobs.ashbyhq.com, site:*.workday.com/*/job, or the company's own /careers pages — rather than only aggregator homepages.
- For every posting you present, include the exact URL returned by the search tool (verbatim). Do NOT paraphrase a posting to a site homepage, and NEVER hand-type or guess a URL. If you could only find a board/search page and not a per-role apply link, say so plainly and give the specific URL you actually retrieved — do not pretend it is a direct link.
- Respect the user's remote preference. Only report jobs you actually found via web search.

If the user asks for notifications but email isn't configured (set_preferences returns emailConfigured: false), tell them to open the Settings panel (the gear icon, top right) and add a Resend API key — it's free at resend.com and takes a minute. Reassure them you can still save their preferences and search jobs in chat meanwhile.

Be concise and friendly. Confirm each step before moving to the next.`;

const MODEL_ID = 'claude-opus-4-8';

// Is the Astro AI Gateway available? (astro_ai_gateway: true injects these.)
const ON_GATEWAY = Boolean(process.env.ASTRO_GATEWAY_URL && process.env.ASTRO_GATEWAY_API_KEY);

/**
 * Model provider selection.
 *
 * - **Astro AI Gateway (default in prod / `ast dev`).** OpenAI-compatible
 *   endpoint at `${ASTRO_GATEWAY_URL}/v1` with the managed per-tenant key — no
 *   provider key to bring. Web search is provided by the gateway's server-side
 *   MCP tool (Tavily), which Bifrost injects and executes gateway-side, so we
 *   do NOT declare a search tool client-side here.
 *   ⚠️ The deployment's gateway virtual key must be granted access to the
 *   Tavily MCP server in Bifrost, or no search tools are injected.
 * - **Direct Anthropic (fallback).** If the gateway env vars are absent (e.g.
 *   local dev without `ast dev`), fall back to `ANTHROPIC_API_KEY` and attach
 *   Anthropic's native server-side `web_search` tool.
 */
function selectModel() {
  if (ON_GATEWAY) {
    const gateway = createOpenAI({
      baseURL: process.env.ASTRO_GATEWAY_URL!.replace(/\/+$/, '') + '/v1',
      apiKey: process.env.ASTRO_GATEWAY_API_KEY!,
    });
    console.log('[model] Astro AI Gateway (OpenAI-compat):', MODEL_ID);
    // .chat() → /v1/chat/completions. The bare gateway(MODEL_ID) call would use
    // the OpenAI Responses API (/v1/responses), which the gateway does not serve
    // (→ 403). The gateway only speaks Chat Completions.
    return gateway.chat(MODEL_ID);
  }
  console.log('[model] direct Anthropic:', MODEL_ID);
  return anthropic(MODEL_ID);
}

// On the gateway, search is the gateway-side MCP `tavily_*` toolset (injected +
// executed by Bifrost) — nothing to declare here. On the direct fallback, use
// Anthropic's native server-side web_search.
//
// web_fetch is intentionally NOT enabled on the fallback: @ai-sdk/anthropic v4
// cannot serialize its error results (web_fetch_tool_result_error) back into a
// prompt, which poisons the conversation. Link liveness is verified in code
// instead — see agent/scheduler.ts -> isLivePosting.
const searchTool: Record<string, ReturnType<typeof anthropic.tools.webSearch_20250305>> =
  ON_GATEWAY ? {} : { web_search: anthropic.tools.webSearch_20250305({ maxUses: 8 }) };

const agent = new Agent({
  id: 'nextgig',
  name: 'NextGig',
  instructions: INSTRUCTIONS,
  model: selectModel(),
  memory,
  tools: {
    ...tools,
    ...searchTool,
  },
  // Ensure traces include stable Astro metadata by default.
  // The collector endpoint is injected by `ast dev`.
  defaultOptions: {
    tracingOptions: {
      tags: ['astro', 'agent:nextgig'],
      metadata: {
        agent_id: 'nextgig',
      },
    },
  },
});

// Instantiate Mastra so it registers agents + OTEL observability at startup.
// (We serve users via the custom frontend below, not the messaging adapter, so
// there is no serve() call — the agent is driven in-process by agent.generate().)
new Mastra({
  agents: {
    'nextgig': agent,
  },
  observability,
});

// Start the in-process notification scheduler (node-cron). Must run after the
// agent is constructed so the scheduler can call agent.generate() for digests.
initScheduler(agent, { memory });

// Serve the custom chat + PDF-upload frontend on port 80. This is the only
// user-facing interface, and Bun.serve keeps the process alive.
startFrontend(agent);
