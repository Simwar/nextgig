/**
 * nextgig - Builds a skill matrix from a user's pasted LinkedIn profile,
 * captures their location and notification preferences, and emails scheduled
 * job-match digests found via web search.
 *
 * Built on Mastra's Agent class. There is no messaging sidecar: the custom
 * frontend (agent/webserver.ts) and the digest scheduler (agent/scheduler.ts)
 * drive the agent in-process via agent.generate().
 *
 * Environment variables (automatically injected by 'ast project start' / deploy):
 *   ASTRO_GATEWAY_URL     - Astro AI Gateway base URL
 *   ASTRO_GATEWAY_API_KEY - managed per-tenant gateway credential (no provider key)
 *   MODEL_DEFAULT         - model selected from astropods.yml models.default.models
 *   POSTGRES_HOST / PORT / USER / PASSWORD / DB - the `db` knowledge store
 *   RESEND_API_KEY / RESEND_FROM - email delivery (optional; also settable in-app)
 */

import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { Observability } from '@mastra/observability';
import { OtelExporter } from '@mastra/otel-exporter';
import { createOpenAI } from '@ai-sdk/openai';
import { ensureDatabase, hasPgCredentials, pgPool } from './storage';
import { tools } from './tools';
import { initScheduler } from './scheduler';
import { startFrontend } from './webserver';

if (!hasPgCredentials()) {
  console.error(
    '[db] POSTGRES_HOST / POSTGRES_PASSWORD are not set — the Postgres knowledge ' +
      'store declared in astropods.yml provides them. Run the agent through ' +
      '`ast project start` (or a deploy), or point the POSTGRES_* vars at your own ' +
      'database. Falling back to localhost:5432.',
  );
}

// Connect (and create the database if the store's volume predates this agent)
// BEFORE anything opens a pool, so a misconfigured store is one clear log line
// rather than an unhandled rejection from inside a library's lazy init.
if (!(await ensureDatabase())) {
  console.error(
    '[db] continuing without a working database — chat and digests will fail ' +
      'until POSTGRES_* points at a reachable Postgres.',
  );
}

// One store for everything Mastra persists — conversation memory plus Mastra's
// own bookkeeping (threads, traces, workflow snapshots) — in the same Postgres
// knowledge store as the skill matrix, preferences, and application history. So
// a restart or redeploy keeps both the data and the chat context. Sharing our
// pool keeps the connection count low (see agent/storage.ts).
const storage = new PostgresStore({
  id: 'nextgig',
  pool: pgPool(),
});

const memory = new Memory({ storage });

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
- Search and discuss matching jobs directly in chat with web_search, applying the saved skills and location.
- Keep track of what they applied to (see APPLICATIONS below).
- Update any saved detail when the user asks (re-call save_profile or set_preferences).

APPLICATIONS. You keep the user's application history, so they never have to remember what they sent off:
- When they say they applied to something — "I applied to the SumUp one", "applied to #2", "just sent my CV to Wolt" — call mark_applied with the URL, title and company exactly as you presented them. Confirm in one short line, and mention how many applications they now have if it's a round number worth noting.
- Work out which posting they mean from the conversation. If it's ambiguous, or the role was never in this conversation, ask which one rather than guessing — never invent a URL to record.
- When they report an outcome — "I have an interview with Wolt", "Talon.One rejected me", "I got an offer", "I withdrew" — call mark_applied again with the same URL and the new status (interviewing / offer / rejected / withdrawn). Put anything else they mention (recruiter name, salary, next step, date) in notes.
- When they ask what they applied to, how many, or where things stand, call list_applications and lay it out clearly: newest first, title and company, the status, when they applied, and the link. If a status other than "applied" is set, show it. If they have none yet, say so and tell them to just mention it whenever they apply.
- Before presenting new matches, if the user has applications on file, don't re-offer a role they already applied to — call list_applications when you're unsure.

Your tools for this: web_search (finds postings; runs server-side, you just ask) and web_fetch (opens one URL and reports what is actually on it).

Finding jobs — and DIRECT application links (important):
- Use web_search to find candidate postings that match the target titles, skills, location, and remote preference. Prefer recent, currently-open roles.
- Bias searches toward individual postings on applicant-tracking systems, which have direct apply links — e.g. add terms like site:boards.greenhouse.io, site:jobs.lever.co, site:jobs.ashbyhq.com, site:*.workday.com/*/job, or the company's own /careers pages — rather than only aggregator homepages.
- For every posting you present, include the exact URL returned by the search tool (verbatim), and keep the source title alongside it. Do NOT paraphrase a posting to a site homepage, and NEVER hand-type or guess a URL. If you could only find a board/search page and not a per-role apply link, say so plainly and give the specific URL you actually retrieved — do not pretend it is a direct link.
- Search results come from a web index that can lag, so before you present a shortlist, call web_fetch on each URL you plan to show, ALWAYS passing expectedTitle and expectedCompany (they run one at a time, so keep the list to about 5). Use the page text to confirm the location and remote status, or to pick up the real apply link from a listing page.
- Then report each posting according to what web_fetch said, not according to the status code:
  - postingGone: true — drop it silently, do not mention it.
  - contentConfirmed: true — present it normally.
  - contentConfirmed: false — you may still present it (browser-rendered boards like Ashby and Workday can never be confirmed this way), but you MUST say in one short clause that you could not confirm it, e.g. "couldn't open the page to verify". Read the confirmation field: if it says the page does not mention the expected title, the link most likely redirects to a generic careers page, so present it as a board link rather than as that role's apply link.
- Never describe a posting as verified, confirmed, or checked unless its web_fetch result had contentConfirmed: true.
- Respect the user's remote preference. Only report jobs you actually found via web_search.

If the user asks for notifications but email isn't configured (set_preferences returns emailConfigured: false), tell them to open the Settings panel (the gear icon, top right) and add a Resend API key — it's free at resend.com and takes a minute. Reassure them you can still save their preferences and search jobs in chat meanwhile.

Be concise and friendly. Confirm each step before moving to the next.

OUTPUT RULES: Your reply to the user must contain ONLY the final, human-facing answer. Never include raw tool output, JSON blobs, or narration about tool calls (e.g. "The output from tool calls is…", "Now I shall call these tools…"). Present job matches as a clean, friendly formatted list with real URLs.`;

/**
 * Model + search: the Astro AI Gateway, no provider API key.
 *
 * `models.default.provider: gateway` in astropods.yml makes the platform inject
 * ASTRO_GATEWAY_URL + ASTRO_GATEWAY_API_KEY (a managed per-tenant credential)
 * and the selected model id as MODEL_DEFAULT. The gateway speaks the
 * OpenAI-compatible API, so @ai-sdk/openai points straight at it.
 */
const GATEWAY_URL = (process.env.ASTRO_GATEWAY_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.ASTRO_GATEWAY_API_KEY ?? '';

if (!GATEWAY_URL || !GATEWAY_KEY) {
  console.error(
    '[model] ASTRO_GATEWAY_URL / ASTRO_GATEWAY_API_KEY are not set — every model ' +
      'call will fail. Run the agent through `ast project start` (or a deploy), ' +
      'which injects the gateway credentials.',
  );
}

const gateway = createOpenAI({
  apiKey: GATEWAY_KEY,
  baseURL: `${GATEWAY_URL}/v1`,
});

// Chosen at deploy time from astropods.yml -> models.default.models.
// Web search requires one of the GPT-5.x models (gpt-5-4, gpt-5-5, gpt-5-6-luna,
// gpt-5-6-sol, gpt-5-6-terra).
const MODEL_ID = process.env.MODEL_DEFAULT ?? 'gpt-5-6-luna';
console.log('[model] Astro AI Gateway:', MODEL_ID);

/**
 * Web search is a SERVER-SIDE tool: the model decides on its own when a question
 * needs current information, the search runs inside the gateway (Bedrock), and
 * the answer comes back grounded with url_citation annotations. Nothing here
 * executes client-side, and no search API key is involved.
 *
 * externalWebAccess MUST stay false. It maps to external_web_access, which
 * defaults to TRUE, and the gateway role is deliberately not granted
 * bedrock-websearch:ExternalWebAccess — leaving the default returns a 403 on the
 * authorization check. false serves retrieval from the Bedrock web index and
 * cache, so request data stays inside the AWS boundary. Live page reads are done
 * by the client-side `web_fetch` tool instead (agent/tools.ts).
 *
 * Mastra's ToolsInput wants a ProviderDefinedTool carrying an `id`; the AI SDK
 * factory does not surface one in its type, so it is added explicitly.
 * 'openai.web_search' is the id Mastra itself uses (WebSearchProviderToolId).
 */
const webSearchTool = {
  ...gateway.tools.webSearch({ externalWebAccess: false }),
  id: 'openai.web_search',
};

const agent = new Agent({
  id: 'nextgig',
  name: 'NextGig',
  instructions: INSTRUCTIONS,
  // Bare gateway(MODEL_ID) targets the OpenAI Responses API (/v1/responses),
  // which is what carries the server-side web_search tool. (Do not switch to
  // gateway.chat() — Chat Completions cannot express provider-executed tools.)
  model: gateway(MODEL_ID),
  memory,
  tools: {
    ...tools,
    web_search: webSearchTool,
  },
  defaultOptions: {
    // A job-search turn is tool-hungry: several web_search rounds, then a
    // web_fetch per candidate, and only then the answer. Mastra's default budget
    // is far smaller, and running out mid-loop ends the turn after a tool call
    // with NO text — which the frontend can only render as an error. Keep this
    // comfortably above a realistic sweep.
    maxSteps: 15,
    // store: false is REQUIRED on this gateway. The Responses API normally lets a
    // client re-send prior turns as `item_reference` ids, and the AI SDK does that
    // whenever store is true (its default) — but the gateway is stateless and
    // silently drops those references. For a client-side tool call that means the
    // follow-up request carries a function_call_output whose function_call is gone,
    // and the gateway rejects it: 400 "No tool call found for function call output
    // with call_id …". With store: false the SDK inlines the real items instead.
    // (Provider-executed web_search *results* are not replayed either way — the
    // model's own summary of them is, which is what later steps actually need.)
    providerOptions: { openai: { store: false } },
    // Ensure traces include stable Astro metadata by default.
    // The collector endpoint is injected by `ast dev`.
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
  storage,
  observability,
});

// Start the in-process notification scheduler (node-cron). Must run after the
// agent is constructed so the scheduler can call agent.generate() for digests.
initScheduler(agent, { memory });

// Serve the custom chat + PDF-upload frontend on port 80. This is the only
// user-facing interface, and Bun.serve keeps the process alive.
startFrontend(agent);
