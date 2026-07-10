/**
 * In-process notification scheduler.
 *
 * Astropods has no native scheduling primitive yet, so we run the scheduler
 * inside the agent: a node-cron tick wakes hourly, finds subscriptions whose
 * cadence interval has elapsed, asks the agent to find matching postings
 * (using Anthropic's native web search — no jobs-API key), de-duplicates them
 * against everything already emailed to that subscriber, and emails only the
 * NEW ones via Resend. Email delivery is done here (not by an LLM tool) so it's
 * deterministic, and every run is logged to digest_runs.
 */

import cron from 'node-cron';
import type { Agent } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import {
  getDueSubscriptions,
  markNotified,
  getRecentSentJobs,
  recordSentJobs,
  logDigestRun,
  type Subscription,
  type SentJobRecord,
} from './db';
import { sendEmail, isEmailConfigured } from './email';

const DAY_MS = 24 * 60 * 60 * 1000;
// How far back to remember sent jobs for de-duplication, and the cap on how
// many to feed the model as an exclusion list.
const DEDUP_LOOKBACK_MS = 60 * DAY_MS;
const DEDUP_MAX = 200;
const EXCLUDE_IN_PROMPT = 60;

// Link verification: open each candidate posting and drop obvious dead ones.
const VERIFY_TIMEOUT_MS = 8000;
const VERIFY_BODY_BYTES = 20000;
const VERIFY_DISABLED = process.env.NEXTGIG_VERIFY_LINKS === '0';
// High-signal phrases that a posting is closed/expired. Kept conservative so we
// don't drop live postings because of generic text elsewhere on the page.
const DEAD_PHRASES = [
  'no longer available',
  'no longer accepting applications',
  'no longer open',
  'position has been filled',
  'this position is closed',
  'this job is closed',
  'posting has expired',
  'this job has expired',
  'this job is no longer',
  'job posting is no longer',
  'this role has been filled',
  'application deadline has passed',
  'job not found',
  'position not found',
];

const CRON_RESOURCE_ID = 'nextgig-scheduler';
const CRON_THREAD_PREFIX = 'digest:';

// Wake at the top of every hour. (Avoid `*` slash exprs in block comments —
// they close the comment early; see build-astropods-agent skill section 9.)
const TICK_EXPR = '0 * * * *';

let agentRef: Agent | null = null;
let memoryRef: Memory | null = null;
const inFlight = new Set<string>();

export interface InitOptions {
  /** Mastra memory instance, used to prune synthetic digest threads. */
  memory?: Memory;
}

/** Start the scheduler. Must be called after the agent is constructed. */
export function initScheduler(agent: Agent, opts: InitOptions = {}): void {
  agentRef = agent;
  memoryRef = opts.memory ?? null;

  if (!cron.validate(TICK_EXPR)) {
    console.error('[scheduler] invalid cron expression, scheduler disabled:', TICK_EXPR);
    return;
  }

  void isEmailConfigured().then((ok) => {
    if (!ok) {
      console.warn(
        '[scheduler] email not configured (no Resend API key) — digests will be ' +
          'skipped until a key is set (Settings panel or RESEND_API_KEY). Chat still works.',
      );
    }
  });

  cron.schedule(TICK_EXPR, () => {
    void tick();
  });

  // Run a tick shortly after boot so already-due subscriptions don't wait an
  // hour. unref() so it never keeps the process alive on its own.
  setTimeout(() => void tick(), 30_000).unref();

  // Hourly sweep of stale synthetic threads (Mastra has no built-in TTL).
  setInterval(() => void pruneThreads(), 60 * 60 * 1000).unref();

  console.log(`[scheduler] started (tick: "${TICK_EXPR}")`);
}

async function tick(): Promise<void> {
  if (!agentRef) return;
  if (!(await isEmailConfigured())) return;
  let due: Subscription[];
  try {
    due = await getDueSubscriptions(Date.now());
  } catch (err) {
    console.error('[scheduler] failed to load due subscriptions:', err);
    return;
  }
  for (const sub of due) {
    try {
      await runDigest(sub);
    } catch (err) {
      console.error(`[scheduler] digest failed for ${sub.id}:`, err);
    }
  }
}

export interface DigestResult {
  sent: boolean;
  /** How many postings the model returned. */
  foundCount: number;
  /** How many were new (after de-duplication) — what actually got emailed. */
  newCount: number;
  body: string;
}

interface Job {
  title: string;
  company: string;
  location: string;
  url: string;
  reason: string;
}

/**
 * Build and send one digest for a subscription. Finds matches, drops anything
 * already emailed to this subscriber, and only sends when there's something
 * new. Called by the hourly tick and by the `send_digest_now` tool (force=true
 * bypasses the in-flight guard). Every run is logged to digest_runs.
 */
export async function runDigest(
  sub: Subscription,
  opts: { force?: boolean } = {},
): Promise<DigestResult> {
  if (!agentRef) throw new Error('Scheduler not initialized.');
  if (!sub.email) throw new Error('Subscription has no email address.');
  if (!(await isEmailConfigured())) throw new Error('Email is not configured.');

  // Skip if a run for this subscriber is already in flight (unless forced).
  if (!opts.force && inFlight.has(sub.id)) {
    return { sent: false, foundCount: 0, newCount: 0, body: '' };
  }
  inFlight.add(sub.id);
  try {
    const now = Date.now();
    const recent = await getRecentSentJobs(sub.id, now - DEDUP_LOOKBACK_MS, DEDUP_MAX);
    const seen = new Set(recent.map((r) => r.fingerprint));

    const result = await agentRef.generate(buildDigestPrompt(sub, recent), {
      memory: {
        thread: `${CRON_THREAD_PREFIX}${sub.id}:${now}`,
        resource: CRON_RESOURCE_ID,
      },
    });

    const parsed = parseJobs(result.text);

    // Fallback: model didn't return clean JSON. Best-effort — send the raw text
    // once, recording URL fingerprints so we still de-dupe next time.
    if (parsed === null) {
      const fresh = extractUrls(result.text).filter((u) => !seen.has('u:' + normUrl(u)));
      if (fresh.length === 0) {
        await logDigestRun(sub.id, now, 0, 0, false);
        await markNotified(sub.id, now);
        return { sent: false, foundCount: 0, newCount: 0, body: '' };
      }
      const body = result.text.trim();
      await sendEmail({ to: sub.email, subject: digestSubject(sub, fresh.length), text: body });
      await recordSentJobs(sub.id, fresh.map((u) => ({ fingerprint: 'u:' + normUrl(u), url: u, title: '', company: '' })), now);
      await logDigestRun(sub.id, now, fresh.length, fresh.length, true);
      await markNotified(sub.id, now);
      return { sent: true, foundCount: fresh.length, newCount: fresh.length, body };
    }

    const fresh: (Job & { fingerprint: string })[] = [];
    for (const j of parsed) {
      const fp = fingerprint(j);
      if (seen.has(fp)) continue;
      seen.add(fp);
      fresh.push({ ...j, fingerprint: fp });
    }

    // Nothing new after de-dup — don't email, but advance the schedule and log.
    if (fresh.length === 0) {
      await logDigestRun(sub.id, now, parsed.length, 0, false);
      await markNotified(sub.id, now);
      return { sent: false, foundCount: parsed.length, newCount: 0, body: '' };
    }

    // Verify each candidate link is a live posting (not a 404 / expired /
    // filled / default page) before emailing.
    const verified = await Promise.all(
      fresh.map(async (j) => ({ job: j, live: await isLivePosting(j.url) })),
    );
    const live = verified.filter((v) => v.live).map((v) => v.job);
    const dead = fresh.length - live.length;
    if (dead) console.log(`[scheduler] ${sub.id}: dropped ${dead} dead/expired link(s) of ${fresh.length}`);

    // Record every fresh candidate (live AND dead) so dead links are not
    // re-proposed or re-checked on the next run.
    await recordSentJobs(
      sub.id,
      fresh.map((f) => ({ fingerprint: f.fingerprint, url: f.url, title: f.title, company: f.company })),
      now,
    );

    // Everything found was dead/duplicate — nothing worth emailing.
    if (live.length === 0) {
      await logDigestRun(sub.id, now, parsed.length, 0, false);
      await markNotified(sub.id, now);
      return { sent: false, foundCount: parsed.length, newCount: 0, body: '' };
    }

    const { text, html } = renderDigest(sub, live);
    await sendEmail({ to: sub.email, subject: digestSubject(sub, live.length), text, html });
    await logDigestRun(sub.id, now, parsed.length, live.length, true);
    await markNotified(sub.id, now);
    return { sent: true, foundCount: parsed.length, newCount: live.length, body: text };
  } finally {
    inFlight.delete(sub.id);
  }
}

function digestSubject(sub: Subscription, n: number): string {
  const where = [sub.city, sub.country].filter(Boolean).join(', ') || 'your area';
  return `NextGig: ${n} new match${n === 1 ? '' : 'es'} in ${where}`;
}

function buildDigestPrompt(sub: Subscription, recent: SentJobRecord[]): string {
  const { matrix } = sub;
  const titles = matrix.targetTitles.join(', ') || matrix.headline || 'roles matching their skills';
  const skills = matrix.skills.map((s) => `${s.name} (${s.level})`).join(', ');
  const location = [sub.city, sub.country].filter(Boolean).join(', ') || 'unspecified';
  const remoteLine =
    sub.remote === 'any' ? 'No remote preference.' : `Remote preference: ${sub.remote}.`;
  const recency = sub.cadence === 'weekly' ? 'the last 7 days' : 'the last 24 hours';

  const excludeBlock =
    recent.length === 0
      ? ''
      : [
          'ALREADY SENT — do NOT include these again, and skip obvious duplicates of them:',
          ...recent
            .slice(0, EXCLUDE_IN_PROMPT)
            .map((r) => `- ${r.title || '?'}${r.company ? ' @ ' + r.company : ''}${r.url ? ' ' + r.url : ''}`),
          '',
        ].join('\n');

  return [
    'You are finding NEW job postings for a candidate and returning them as JSON.',
    'Use the web_search tool to find REAL, currently-open postings.',
    '',
    'Candidate profile:',
    `- Target titles: ${titles}`,
    `- Key skills: ${skills || 'see notes'}`,
    matrix.notes ? `- Notes: ${matrix.notes}` : '',
    `- Location: ${location}`,
    `- ${remoteLine}`,
    '',
    `Find postings published within ${recency} that match the titles, skills, and location (include remote if allowed).`,
    'Bias toward individual postings on applicant-tracking systems with direct apply links',
    '(site:boards.greenhouse.io, site:jobs.lever.co, site:jobs.ashbyhq.com, company /careers pages), not aggregator homepages.',
    '',
    excludeBlock,
    'Return ONLY a JSON object (no prose, no markdown, no code fences) of exactly this shape:',
    '{"jobs":[{"title":"...","company":"...","location":"...","url":"https://...","reason":"one line on why it fits"}]}',
    '- At most 8 of the strongest NEW matches, best first.',
    '- Every "url" MUST be a real URL returned by the tools, verbatim — never invent, guess, or use a homepage.',
    '- Prefer postings that look currently OPEN; do not include ones you can tell are expired or filled.',
    '- If you find nothing new, return {"jobs":[]}.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Stable identity for a posting: normalized URL if present, else title|company. */
function fingerprint(j: Job): string {
  const u = normUrl(j.url);
  if (u) return 'u:' + u;
  return 't:' + j.title.trim().toLowerCase() + '|' + j.company.trim().toLowerCase();
}

function normUrl(u: string): string {
  return (u || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[#?].*$/, '').replace(/\/+$/, '');
}

/** Parse the model's JSON output. Returns null if it isn't valid JSON. */
function parseJobs(text: string): Job[] | null {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e < s) return null;
  try {
    const obj = JSON.parse(t.slice(s, e + 1));
    const arr = Array.isArray(obj?.jobs) ? obj.jobs : [];
    return arr
      .map((j: Record<string, unknown>) => ({
        title: String(j?.title ?? '').trim(),
        company: String(j?.company ?? '').trim(),
        location: String(j?.location ?? '').trim(),
        url: String(j?.url ?? '').trim(),
        reason: String(j?.reason ?? '').trim(),
      }))
      .filter((j: Job) => j.title || j.url);
  } catch {
    return null;
  }
}

function extractUrls(text: string): string[] {
  const out: string[] = [];
  const re = /(https?:\/\/[^\s<>()\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1].replace(/[.,;:!?)]+$/, ''));
  return out;
}

/**
 * Open a candidate posting URL and decide whether it's a live job posting.
 * Conservative on purpose: reports NOT-live only on an HTTP 404/410 or a
 * high-signal closed/expired phrase in the page body. Network errors, timeouts,
 * bot-blocks (403/999), and 5xx are treated as live (uncertain) so we never
 * over-prune genuine postings we simply couldn't fetch.
 */
async function isLivePosting(url: string): Promise<boolean> {
  if (VERIFY_DISABLED) return true;
  if (!/^https?:\/\//i.test(url)) return false; // no usable link -> not worth emailing
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NextGigBot/1.0; +https://astropods.com)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
    });
    if (res.status === 404 || res.status === 410) return false;
    let body = '';
    try {
      body = (await res.text()).slice(0, VERIFY_BODY_BYTES).toLowerCase();
    } catch {
      return true; // couldn't read body -> don't prune
    }
    return !DEAD_PHRASES.some((p) => body.includes(p));
  } catch {
    return true; // timeout / network error / blocked -> uncertain, keep it
  } finally {
    clearTimeout(timer);
  }
}

function renderDigest(sub: Subscription, jobs: Job[]): { text: string; html: string } {
  const where = [sub.city, sub.country].filter(Boolean).join(', ') || 'your area';
  const intro = `Here ${jobs.length === 1 ? 'is' : 'are'} ${jobs.length} new job match${jobs.length === 1 ? '' : 'es'} in ${where}:`;

  const textLines = [intro, ''];
  jobs.forEach((j, i) => {
    textLines.push(`${i + 1}. ${j.title}${j.company ? ' - ' + j.company : ''}${j.location ? ' (' + j.location + ')' : ''}`);
    if (j.reason) textLines.push(`   Why: ${j.reason}`);
    if (j.url) textLines.push(`   Apply: ${j.url}`);
    textLines.push('');
  });
  textLines.push('You are receiving this because you asked NextGig for job alerts.');

  const items = jobs
    .map((j) => {
      const loc = j.location ? ` <span style="color:#888">(${escapeHtml(j.location)})</span>` : '';
      const reason = j.reason ? `<div style="color:#555;font-size:14px">${escapeHtml(j.reason)}</div>` : '';
      const link = j.url ? `<div><a href="${escapeAttr(j.url)}">Apply</a></div>` : '';
      return `<li style="margin:0 0 14px"><b>${escapeHtml(j.title)}</b>${j.company ? ' - ' + escapeHtml(j.company) : ''}${loc}${reason}${link}</li>`;
    })
    .join('');
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px">` +
    `<p>${escapeHtml(intro)}</p><ul style="padding-left:18px">${items}</ul>` +
    `<p style="color:#888;font-size:12px">You are receiving this because you asked NextGig for job alerts.</p></div>`;

  return { text: textLines.join('\n'), html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

async function pruneThreads(): Promise<void> {
  if (!memoryRef) return;
  try {
    const { threads } = await memoryRef.listThreads({
      filter: { resourceId: CRON_RESOURCE_ID },
      perPage: false,
    });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const t of threads) {
      const ts = Number(String(t.id).split(':').pop());
      if (Number.isFinite(ts) && ts < cutoff) await memoryRef.deleteThread(t.id);
    }
  } catch (err) {
    console.error('[scheduler] thread prune failed:', err);
  }
}
