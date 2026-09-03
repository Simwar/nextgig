/**
 * Custom chat frontend for NextGig.
 *
 * Serves a single-page chat UI on port 80 (the port the Astropods platform
 * routes to for `agent.interfaces.frontend`). PDF uploads (LinkedIn export or
 * CV) are parsed to text server-side and fed to the agent exactly like a pasted
 * profile — no scraping, no extra API key. Chat and upload both call the Mastra
 * agent in-process via agent.generate().
 *
 * A per-browser session cookie drives both the memory thread and the subscriber
 * id (set via requestContext, so the tools persist to the right subscription).
 *
 * Turns are long (a PDF upload or a job search can run for a minute), and the
 * agent keeps working even if the browser connection dies — an ingress read
 * timeout in front of the agent will cut the response while the model call runs
 * to completion and its reply is stored in memory. So the reply is never only in
 * flight: `GET /api/history` reads it back from the thread, which lets the UI
 * recover from a dropped stream and repopulate on reload.
 */

import type { Agent } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import { extractText, getDocumentProxy } from 'unpdf';
import { requestContext } from './context';
import { INDEX_HTML } from './frontend';
import { emailStatus, saveEmailSettings, sendTestEmail } from './email';
import { getSetting, setSetting } from './settings';
import { cleanReply } from './sanitize';

const SESSION_COOKIE = 'jh_session';

/**
 * Opening of the prompt synthesized for a PDF upload. Shared with readHistory,
 * which recognises it and shows the file name instead of replaying the whole
 * extracted profile back into the chat.
 */
const UPLOAD_PROMPT_PREFIX = "I've uploaded my professional profile ";

/**
 * Asked on the same thread when a turn produces no text, so the model writes up
 * what its tools already returned instead of the user seeing an error.
 */
const NUDGE_PROMPT =
  'Write your reply to my last message now, using what you already found. Do not call any tools.';
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB

/** Parse the session id from the Cookie header, or mint a new one. */
function resolveSession(req: Request): { id: string; isNew: boolean } {
  const cookie = req.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)jh_session=([^;]+)/);
  if (match) return { id: decodeURIComponent(match[1]), isNew: false };
  return { id: crypto.randomUUID(), isNew: true };
}

function json(body: unknown, session: { id: string; isNew: boolean }, status = 200): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (session.isNew) {
    headers['Set-Cookie'] =
      `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
  }
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The memory thread id for a session. A persisted "epoch" lets us abandon a
 * poisoned thread (see below) permanently — starts at the bare sessionId, then
 * sessionId#1, #2, ... once rotated.
 */
async function chatThreadId(sessionId: string): Promise<string> {
  const e = await getSetting('thread_epoch:' + sessionId);
  const n = e ? Number(e) : 0;
  return n > 0 ? sessionId + '#' + n : sessionId;
}

async function rotateChatThread(sessionId: string): Promise<string> {
  const e = await getSetting('thread_epoch:' + sessionId);
  const n = (e ? Number(e) : 0) + 1;
  await setSetting('thread_epoch:' + sessionId, String(n));
  return sessionId + '#' + n;
}

/**
 * A stored tool result the provider can't re-serialize (e.g. a server-side
 * web_search error block the provider rejects on replay) makes the whole thread
 * history un-replayable — every later turn throws while converting the stored
 * messages back into a prompt. Detect that so we can recover by starting fresh.
 */
function isHistoryPoisonError(err: unknown): boolean {
  const s = err instanceof Error ? err.stack || err.message : String(err);
  return /web_fetch_tool_result_error|web_search_tool_result|convertToAnthropicPrompt|AI_TypeValidationError/.test(
    s || '',
  );
}

/**
 * Produce the agent's reply for a session and emit it via onDelta.
 *
 * The model call is NON-STREAMING (`agent.generate()`). The gateway's web_search
 * runs server-side and returns nothing until the grounded answer is complete, so
 * there is little to stream anyway; the browser connection is kept alive during
 * the (silent) generate() by the heartbeat in streamingResponse, and the full
 * text is emitted as a single chunk when it resolves. (Streaming was originally
 * ruled out by Bifrost's MCP agent mode, which skips its tool loop on
 * `chat_stream`; that no longer applies now that search is a provider-executed
 * tool, so token-by-token output could be revisited.)
 *
 * Keeps conversation memory + subscriber id aligned, and self-heals a poisoned
 * history by rotating to a fresh thread (safe here: nothing is emitted until
 * generate() resolves, so the retry never double-emits).
 */
async function streamReply(
  agent: Agent,
  sessionId: string,
  prompt: string,
  onDelta: (chunk: string) => void,
  onStatus: (message: string) => void = () => {},
): Promise<string> {
  return requestContext.run({ userId: sessionId, onStatus }, async () => {
    const generateOn = async (thread: string): Promise<string> => {
      const res = await agent.generate(prompt, {
        memory: { thread, resource: sessionId },
        onStepFinish: (step: unknown) => onStatus(describeStep(step)),
      });
      // Strip any Bifrost agent-mode tool-dump / narration scaffolding.
      const text = cleanReply(res.text);
      if (text) return text;

      // The turn ended with no text at all — seen when a long search + fetch
      // sweep uses up the step budget right after a tool call. The model already
      // has everything it needs, so ask it once for the answer with tools off
      // rather than showing the user an error.
      console.warn('[frontend] model returned no usable text; asking for a final answer', {
        finishReason: (res as { finishReason?: string }).finishReason,
        steps: (res as { steps?: unknown[] }).steps?.length,
      });
      onStatus('Writing up what I found…');
      const retry = await agent.generate(NUDGE_PROMPT, {
        memory: { thread, resource: sessionId },
        toolChoice: 'none',
      });
      return cleanReply(retry.text);
    };
    const firstThread = await chatThreadId(sessionId);
    let text: string;
    try {
      text = await generateOn(firstThread);
    } catch (err) {
      if (!isHistoryPoisonError(err)) throw err;
      console.warn('[frontend] conversation history unusable; rotating to a fresh thread for', sessionId);
      const fresh = await rotateChatThread(sessionId);
      text = await generateOn(fresh);
    }
    // Still nothing to say: emit something honest rather than letting the
    // frontend fall back to a bare "Something went wrong."
    if (!text) {
      console.error('[frontend] no reply produced even after the final-answer retry');
      text =
        "Sorry — I ran that search but couldn't put the reply together. Ask me again and I'll " +
        'have another go.';
    }
    onDelta(text);
    return text;
  });
}

/** One rendered turn for the UI. */
export interface HistoryMessage {
  role: 'user' | 'bot';
  text: string;
}

/**
 * The conversation for a session, oldest first, flattened to plain text.
 *
 * Reads the same thread the chat turns write to (including the rotated thread,
 * if a poisoned history forced a rotation). Tool calls, tool results and empty
 * assistant turns are dropped — this feeds a chat bubble, not the model.
 */
async function readHistory(memory: Memory, sessionId: string): Promise<HistoryMessage[]> {
  const thread = await chatThreadId(sessionId);
  const { messages } = await memory.recall({
    threadId: thread,
    resourceId: sessionId,
    perPage: false,
    page: 0,
  });
  const out: HistoryMessage[] = [];
  for (const message of messages) {
    const role = message.role === 'user' ? 'user' : message.role === 'assistant' ? 'bot' : null;
    if (!role) continue;
    const text = flattenText(message.content);
    if (text) out.push({ role, text: role === 'user' ? displayUserText(text) : text });
  }
  return out;
}

/**
 * What the user actually did, for a replayed user turn. A PDF upload is stored
 * as a synthesized prompt wrapping the whole extracted profile; showing that
 * back would be a wall of text they never typed, so it collapses to the file
 * name — which is what the live UI shows too.
 */
function displayUserText(text: string): string {
  if (!text.startsWith(UPLOAD_PROMPT_PREFIX)) return text;
  const name = text.match(/\(from "([^"]+)"\)/);
  return name ? `📎 ${name[1]}` : '📎 Uploaded profile';
}

/** Pull the human-readable text out of a stored message's content. */
function flattenText(content: unknown): string {
  if (typeof content === 'string') return cleanReply(content);
  const parts = (content as { parts?: unknown[]; content?: unknown[] })?.parts
    ?? (content as { content?: unknown[] })?.content
    ?? (Array.isArray(content) ? content : []);
  const text = (parts as unknown[])
    .map((p) => {
      if (typeof p === 'string') return p;
      const part = p as { type?: string; text?: string };
      return part?.type === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .join('')
    .trim();
  return cleanReply(text);
}

/**
 * Progress line for a finished generation step.
 *
 * This only reports the gateway's provider-executed `web_search`, because that
 * is the one piece of work no tool of ours can announce: it runs inside the
 * gateway. Our own tools report themselves from inside `execute` via
 * `reportStatus`, which is both earlier and more specific (it names the host
 * being opened), so adding a step-level line for them would just overwrite a
 * better message with a vaguer one.
 *
 * Returns '' for "no update" — never a generic filler, which would otherwise
 * reset the label to "Thinking…" after every tool call.
 *
 * Note the shape: Mastra wraps each call, so the name is at `payload.toolName`.
 */
function describeStep(step: unknown): string {
  const calls =
    (step as { toolCalls?: { toolName?: string; payload?: { toolName?: string } }[] })?.toolCalls ??
    [];
  const names = calls
    .map((c) => c?.payload?.toolName ?? c?.toolName)
    .filter((n): n is string => Boolean(n));
  return names.some((n) => n.includes('web_search')) ? 'Searching the web…' : '';
}

/**
 * Build a streamed NDJSON response that runs `producer` (which emits text
 * deltas and status lines) while sending a heartbeat every 15s. This keeps bytes flowing during
 * long, silent web-search turns so no idle-timeout (Bun or platform ingress)
 * drops the connection. Each line is one JSON event:
 *   {"t":"delta","v":"..."} | {"t":"status","v":"..."} | {"t":"ping"} |
 *   {"t":"done"} | {"t":"error","v":"..."}
 *
 * Status lines are what the user sees while generate() is silent, so one is sent
 * immediately and then whenever a tool reports progress.
 */
function streamingResponse(
  session: { id: string; isNew: boolean },
  producer: (
    onDelta: (chunk: string) => void,
    onStatus: (message: string) => void,
  ) => Promise<string>,
  onError: (err: unknown) => string,
  initialStatus = 'Thinking…',
): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); } catch { /* closed */ }
      };
      const heartbeat = setInterval(() => send({ t: 'ping' }), 15000);
      send({ t: 'status', v: initialStatus });
      try {
        let lastStatus = initialStatus;
        await producer(
          (chunk) => send({ t: 'delta', v: chunk }),
          (message) => {
            // Skip repeats so the label doesn't flicker on a run of similar steps.
            if (!message || message === lastStatus) return;
            lastStatus = message;
            send({ t: 'status', v: message });
          },
        );
        send({ t: 'done' });
      } catch (err) {
        console.error('[frontend] stream producer failed:', err);
        send({ t: 'error', v: onError(err) });
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // ask proxies not to buffer, so heartbeats flush
  };
  if (session.isNew) {
    headers['Set-Cookie'] =
      `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
  }
  return new Response(body, { headers });
}

/** Start the frontend HTTP server. Call after the agent is constructed. */
export interface FrontendOptions {
  /** Mastra memory, used to read a thread back for /api/history. */
  memory: Memory;
}

export function startFrontend(agent: Agent, opts: FrontendOptions): void {
  const port = Number(process.env.PORT) || 80;

  Bun.serve({
    port,
    idleTimeout: 255, // max; the 15s heartbeat in streamingResponse keeps bytes flowing anyway
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const session = resolveSession(req);

      // Health check for the platform.
      if (url.pathname === '/health') {
        return new Response('ok', { status: 200 });
      }

      // Serve the chat UI.
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8' };
        if (session.isNew) {
          headers['Set-Cookie'] =
            `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`;
        }
        return new Response(INDEX_HTML, { headers });
      }

      // Chat turn (streamed NDJSON so long web-search turns don't hit an idle timeout).
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        const body = (await req.json().catch(() => ({}))) as { message?: string };
        const message = (body.message || '').trim();
        if (!message) return json({ error: 'Empty message.' }, session, 400);
        return streamingResponse(
          session,
          (onDelta, onStatus) => streamReply(agent, session.id, message, onDelta, onStatus),
          () => 'The agent could not respond. Please try again.',
        );
      }

      // Read the conversation back from memory. Two jobs: repopulate the UI on
      // reload, and let the client recover a reply whose stream died mid-turn
      // (the turn still completed server-side). `after` lets the client ask for
      // "anything newer than what I already have".
      if (req.method === 'GET' && url.pathname === '/api/history') {
        const after = Number(url.searchParams.get('after') ?? '0');
        try {
          const messages = await readHistory(opts.memory, session.id);
          return json(
            { messages: Number.isFinite(after) && after > 0 ? messages.slice(after) : messages, total: messages.length },
            session,
          );
        } catch (err) {
          console.error('[frontend] history read failed:', err);
          return json({ messages: [], total: 0 }, session, 500);
        }
      }

      // PDF upload → extract text → onboard.
      if (req.method === 'POST' && url.pathname === '/api/upload') {
        const form = await req.formData().catch(() => null);
        const file = form?.get('pdf');
        if (!(file instanceof File)) return json({ error: 'No PDF uploaded.' }, session, 400);
        if (file.size > MAX_PDF_BYTES) {
          return json({ error: 'That PDF is larger than 10 MB. Please upload a smaller file.' }, session, 400);
        }

        // Step 1 — extract text. A failure here really is a PDF problem.
        let profileText: string;
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const pdf = await getDocumentProxy(bytes);
          const { text } = await extractText(pdf, { mergePages: true });
          profileText = (text || '').trim();
        } catch (err) {
          console.error('[frontend] PDF parse failed:', err);
          return json({ error: 'Could not read that PDF. Please try another file or paste your profile.' }, session, 500);
        }

        if (profileText.length < 80) {
          return json(
            {
              error:
                "I couldn't extract readable text from that PDF — it may be scanned or image-based. " +
                'Try a text-based export (LinkedIn: More → Save to PDF), or paste your profile text into the chat.',
            },
            session,
          );
        }

        const prompt =
          `${UPLOAD_PROMPT_PREFIX}(from "${file.name}"). Here is the extracted text ` +
          `between the markers. Build my skill matrix from it (call save_profile), briefly summarize what ` +
          `you captured, then continue onboarding by asking about my location.\n\n` +
          `<<<PROFILE\n${profileText}\nPROFILE>>>`;

        // Step 2 — stream the agent's reply. A failure here is a model/config
        // problem (e.g. missing gateway credentials), NOT a PDF problem — say so.
        return streamingResponse(
          session,
          (onDelta, onStatus) => streamReply(agent, session.id, prompt, onDelta, onStatus),
          () =>
            "I read your PDF fine, but the agent couldn't respond — the model call failed " +
            '(most often missing/invalid Astro AI Gateway credentials, or a rate limit). Check the server logs and try again.',
          'Reading your profile…',
        );
      }

      // Email (Resend) configuration for the operator. The API key is never
      // returned to the client — only status. NOTE: these endpoints are not
      // auth-gated; for a publicly exposed deployment, set RESEND_API_KEY via
      // `ast secrets` (env wins) rather than relying on the in-app field.
      if (req.method === 'GET' && url.pathname === '/api/email-config') {
        return json(await emailStatus(), session);
      }
      if (req.method === 'POST' && url.pathname === '/api/email-config') {
        try {
          const body = (await req.json()) as { apiKey?: string; from?: string };
          await saveEmailSettings({ apiKey: body.apiKey, from: body.from });
          return json(await emailStatus(), session);
        } catch (err) {
          console.error('[frontend] /api/email-config failed:', err);
          return json({ error: 'Could not save email settings.' }, session, 500);
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/email-test') {
        try {
          const body = (await req.json()) as { to?: string };
          const to = (body.to || '').trim();
          if (!to) return json({ error: 'Enter an email address to send the test to.' }, session, 400);
          await sendTestEmail(to);
          return json({ ok: true, sentTo: to }, session);
        } catch (err) {
          // Surface Resend's own message (e.g. "domain not verified", bad key).
          return json({ error: err instanceof Error ? err.message : 'Failed to send test email.' }, session);
        }
      }

      return new Response('Not found', { status: 404 });
    },
  });

  console.log(`[frontend] chat UI listening on :${port}`);
}
