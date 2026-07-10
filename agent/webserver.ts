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
 */

import type { Agent } from '@mastra/core/agent';
import { extractText, getDocumentProxy } from 'unpdf';
import { requestContext } from './context';
import { INDEX_HTML } from './frontend';
import { emailStatus, saveEmailSettings, sendTestEmail } from './email';
import { getSetting, setSetting } from './settings';

const SESSION_COOKIE = 'jh_session';
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
 * A stored tool result the provider can't re-serialize (e.g. an Anthropic
 * server-tool error block that @ai-sdk/anthropic rejects) makes the whole
 * thread history un-replayable — every later turn throws in
 * convertToAnthropicPrompt. Detect that so we can recover by starting fresh.
 */
function isHistoryPoisonError(err: unknown): boolean {
  const s = err instanceof Error ? err.stack || err.message : String(err);
  return /web_fetch_tool_result_error|web_search_tool_result|convertToAnthropicPrompt|AI_TypeValidationError/.test(
    s || '',
  );
}

/** Run the agent for a session, keeping conversation memory and subscriber id aligned. */
async function generate(agent: Agent, sessionId: string, prompt: string): Promise<string> {
  return requestContext.run({ userId: sessionId }, async () => {
    const thread = await chatThreadId(sessionId);
    try {
      return (await agent.generate(prompt, { memory: { thread, resource: sessionId } })).text;
    } catch (err) {
      if (!isHistoryPoisonError(err)) throw err;
      // History can't be replayed — abandon it (persistently) and retry once on
      // a fresh thread so the conversation self-heals instead of staying stuck.
      console.warn('[frontend] conversation history unusable; rotating to a fresh thread for', sessionId);
      const fresh = await rotateChatThread(sessionId);
      return (await agent.generate(prompt, { memory: { thread: fresh, resource: sessionId } })).text;
    }
  });
}

/** Start the frontend HTTP server. Call after the agent is constructed. */
export function startFrontend(agent: Agent): void {
  const port = Number(process.env.PORT) || 80;

  Bun.serve({
    port,
    idleTimeout: 120, // allow long agentic (web-search) turns to complete
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

      // Chat turn.
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        try {
          const body = (await req.json()) as { message?: string };
          const message = (body.message || '').trim();
          if (!message) return json({ error: 'Empty message.' }, session, 400);
          const reply = await generate(agent, session.id, message);
          return json({ reply }, session);
        } catch (err) {
          console.error('[frontend] /api/chat failed:', err);
          return json({ error: 'The agent could not respond. Please try again.' }, session, 500);
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
          `I've uploaded my professional profile (from "${file.name}"). Here is the extracted text ` +
          `between the markers. Build my skill matrix from it (call save_profile), briefly summarize what ` +
          `you captured, then continue onboarding by asking about my location.\n\n` +
          `<<<PROFILE\n${profileText}\nPROFILE>>>`;

        // Step 2 — run the agent. A failure here is a model/config problem
        // (e.g. missing ANTHROPIC_API_KEY), NOT a problem with the PDF — so say so.
        try {
          const reply = await generate(agent, session.id, prompt);
          return json({ reply }, session);
        } catch (err) {
          console.error('[frontend] /api/upload generation failed:', err);
          return json(
            {
              error:
                "I read your PDF fine, but the agent couldn't respond — the model call failed " +
                '(most often a missing/invalid ANTHROPIC_API_KEY, or a rate limit). Check the server logs and try again.',
            },
            session,
            502,
          );
        }
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
