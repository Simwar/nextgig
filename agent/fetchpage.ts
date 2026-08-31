/**
 * Live page fetch and posting-verification helpers, shared by the `web_fetch`
 * tool (agent/tools.ts) and the scheduler's link check (agent/scheduler.ts).
 *
 * Why this exists alongside the gateway's server-side `web_search`: that tool
 * runs with `externalWebAccess: false` (see agent/index.ts and
 * docs/ai-gateway.md), so its `openPage` / `findInPage` actions are served from
 * the Bedrock web index and cache rather than the live web. Fetching a specific
 * posting — to confirm it is still open and to pull the real apply link — is
 * done here instead: a plain HTTP GET from the agent container, HTML reduced to
 * readable text.
 */

/** Raw HTML we are willing to read from one page. */
const MAX_HTML_BYTES = 300_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; NextGigBot/1.0; +https://astropods.com)';

export interface FetchedPage {
  /** True when the HTTP request completed (any status code). */
  completed: boolean;
  /** HTTP status, or 0 when the request never completed. */
  status: number;
  /** URL after redirects (the requested URL if unknown). */
  url: string;
  /** Raw HTML, capped at MAX_HTML_BYTES. */
  html: string;
  /** Visible text extracted from `html`. */
  text: string;
  /** Set when the request failed (timeout, DNS, TLS, aborted…). */
  error?: string;
}

export interface FetchPageOptions {
  timeoutMs?: number;
}

/**
 * GET a URL and return its status plus text. Never throws — transport failures
 * come back as `completed: false` with `error` set, so callers can decide
 * whether "couldn't fetch" means "bad link" or just "unknown".
 */
export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchedPage> {
  const base: FetchedPage = { completed: false, status: 0, url, html: '', text: '' };
  if (!/^https?:\/\//i.test(url)) {
    return { ...base, error: 'Only http(s) URLs can be fetched.' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
    });
    let html = '';
    try {
      html = (await res.text()).slice(0, MAX_HTML_BYTES);
    } catch {
      // Body unreadable (e.g. stream aborted) — status is still useful.
    }
    return {
      completed: true,
      status: res.status,
      url: res.url || url,
      html,
      text: htmlToText(html),
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/** Strip scripts, styles, and tags; collapse whitespace and decode common entities. */
export function htmlToText(html: string): string {
  if (!html) return '';
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/**
 * High-signal phrases that a posting is closed/expired/filled. Kept
 * deliberately conservative so a live posting is never dropped because of
 * generic text elsewhere on the page.
 */
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

/** Does this page body read as a closed/expired posting? */
export function looksClosed(body: string): boolean {
  const b = (body || '').toLowerCase();
  return DEAD_PHRASES.some((p) => b.includes(p));
}

/**
 * Below this much extracted text, a 200 response tells us nothing: it is almost
 * always a JavaScript-rendered shell (Ashby, Workday and friends serve ~4 chars
 * of text to a plain GET) rather than a real page we can read.
 */
export const MIN_CONTENT_CHARS = 500;

/**
 * Does `body` mention `phrase`? Tolerant on purpose: pages reformat titles
 * ("Senior Backend Engineer (Go)" vs "Senior Backend Engineer, Payments"), so an
 * exact substring is tried first and then a majority of the phrase's
 * significant words. Short filler words are ignored; everything else counts,
 * including words like "senior" that carry real signal in a job title.
 */
export function mentionsPhrase(body: string, phrase: string): boolean {
  const text = normalize(body);
  const target = normalize(phrase);
  if (!text || !target) return false;
  if (text.includes(target)) return true;
  const words = target.split(' ').filter((w) => w.length >= 4);
  if (words.length === 0) return false;
  const hits = words.filter((w) => text.includes(w)).length;
  return hits / words.length >= 0.6;
}

/** Lowercase, and reduce anything that isn't a letter or digit to a single space. */
function normalize(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Path segments that identify a board section rather than an individual posting. */
const GENERIC_SEGMENTS = new Set([
  'jobs', 'job', 'careers', 'career', 'apply', 'application', 'applications',
  'positions', 'position', 'openings', 'opening', 'vacancies', 'roles', 'role',
]);

/**
 * Did a redirect drop the posting's identifier?
 *
 * Boards routinely answer an unknown or expired job id with their generic
 * careers page — and that page can be byte-identical to a real posting's page
 * (it lists every open role, so even a title match succeeds). The one thing that
 * still distinguishes them is the URL we ended up on: a genuine posting keeps its
 * id through any redirect, while a fallback drops it.
 *
 * Returns the lost identifier, or null when the id survived (or when the URL had
 * no identifier to check).
 */
export function lostPostingId(requested: string, final: string): string | null {
  if (!final || final === requested) return null;
  let segments: string[];
  try {
    segments = new URL(requested).pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  const finalUrl = safeDecode(final).toLowerCase();
  // Walk back from the end to the first segment that looks like a posting id.
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment.length < 4 || GENERIC_SEGMENTS.has(segment.toLowerCase())) continue;
    return finalUrl.includes(segment.toLowerCase()) ? null : segment;
  }
  return null;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
