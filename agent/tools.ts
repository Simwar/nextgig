/**
 * Tools the nextgig agent uses during onboarding and on demand.
 *
 * Web search is the Astro AI Gateway's server-side `web_search` tool, wired in
 * agent/index.ts — it runs gateway-side and needs nothing here. The tools below
 * are the client-side ones: they persist what the model learns, let the user
 * trigger an immediate digest, and open a specific page (`web_fetch`).
 */

import { createTool } from '@mastra/core/tools';
import type { FetchedPage } from './fetchpage';
import { z } from 'zod';
import { currentSubscriberId, reportStatus } from './context';
import {
  getSubscription,
  upsertSubscription,
  recordApplication,
  listApplications,
  type RemotePreference,
  type Cadence,
  type Skill,
  type Application,
  type ApplicationStatus,
} from './db';
import { runDigest } from './scheduler';
import { isEmailConfigured } from './email';
import {
  fetchPage,
  looksClosed,
  lostPostingId,
  mentionsPhrase,
  MIN_CONTENT_CHARS,
} from './fetchpage';

const skillSchema = z.object({
  name: z.string().describe('Skill name, e.g. "TypeScript", "Kubernetes", "Product strategy".'),
  level: z
    .string()
    .describe('Proficiency: "expert", "advanced", "intermediate", or "beginner".'),
  // Accept a string too: the model routinely sends "5" or "5+" here, and a
  // strict number schema rejected the whole save_profile call over it.
  years: z
    .union([z.number(), z.string()])
    .optional()
    .describe('Approximate years of experience, if known. A number, or a string like "5" or "5+".'),
});

type SkillInput = z.infer<typeof skillSchema>;

/** Host of a URL, for progress messages. Falls back to the raw string. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Normalize `years` to a number: 5, "5", "5+", "~3 years" → 5/5/5/3; junk → undefined. */
function normalizeSkills(skills: SkillInput[]): Skill[] {
  return skills.map(({ name, level, years }) => {
    if (typeof years === 'number') {
      return { name, level, ...(Number.isFinite(years) ? { years } : {}) };
    }
    const match = typeof years === 'string' ? years.match(/\d+(?:\.\d+)?/) : null;
    return { name, level, ...(match ? { years: Number(match[0]) } : {}) };
  });
}

export const saveProfile = createTool({
  id: 'save_profile',
  description:
    'Persist the skill matrix extracted from the user\'s pasted LinkedIn profile or resume. ' +
    'Call this once you have parsed their experience into structured skills and target job titles.',
  inputSchema: z.object({
    headline: z.string().optional().describe('Current role / headline, e.g. "Senior Backend Engineer".'),
    targetTitles: z
      .array(z.string())
      .describe('Job titles to search for, derived from their experience and goals.'),
    skills: z.array(skillSchema).describe('The skill matrix.'),
    notes: z
      .string()
      .optional()
      .describe('Free-form context (industries, seniority, domains) to refine job searches.'),
  }),
  execute: async ({ headline, targetTitles, skills, notes }) => {
    reportStatus('Saving your skill matrix…');
    const id = currentSubscriberId();
    const sub = await upsertSubscription(id, {
      matrix: { headline, targetTitles, skills: normalizeSkills(skills), notes },
    });
    return {
      ok: true,
      savedSkills: sub.matrix.skills.length,
      targetTitles: sub.matrix.targetTitles,
    };
  },
});

export const setPreferences = createTool({
  id: 'set_preferences',
  description:
    'Save or update the user\'s location and notification preferences. All fields are optional — ' +
    'call it incrementally as you collect details. Set active=true only once the user has opted in ' +
    'to email notifications AND provided an email address.',
  inputSchema: z.object({
    email: z.string().email().optional().describe('Email address to send job digests to.'),
    city: z.string().optional().describe('City the user wants jobs in.'),
    country: z.string().optional().describe('Country the user wants jobs in.'),
    remote: z
      .enum(['remote', 'hybrid', 'onsite', 'any'])
      .optional()
      .describe('Remote-work preference.'),
    cadence: z
      .enum(['daily', 'weekly'])
      .optional()
      .describe('How often to send job digests.'),
    active: z
      .boolean()
      .optional()
      .describe('Whether scheduled email notifications are enabled.'),
  }),
  execute: async ({ email, city, country, remote, cadence, active }) => {
    reportStatus('Saving your preferences…');
    const id = currentSubscriberId();
    const sub = await upsertSubscription(id, {
      email,
      city,
      country,
      remote: remote as RemotePreference | undefined,
      cadence: cadence as Cadence | undefined,
      active,
    });
    return {
      ok: true,
      emailConfigured: await isEmailConfigured(),
      subscription: {
        email: sub.email,
        city: sub.city,
        country: sub.country,
        remote: sub.remote,
        cadence: sub.cadence,
        active: sub.active,
      },
    };
  },
});

export const getProfile = createTool({
  id: 'get_profile',
  description:
    'Retrieve the current saved profile and preferences for this user, so you can confirm or summarize them.',
  inputSchema: z.object({}),
  execute: async () => {
    reportStatus('Looking up your saved profile…');
    const id = currentSubscriberId();
    const sub = await getSubscription(id);
    if (!sub) return { exists: false };
    return {
      exists: true,
      headline: sub.matrix.headline,
      targetTitles: sub.matrix.targetTitles,
      skills: sub.matrix.skills,
      notes: sub.matrix.notes,
      email: sub.email,
      city: sub.city,
      country: sub.country,
      remote: sub.remote,
      cadence: sub.cadence,
      active: sub.active,
      lastRunAt: sub.lastRunAt,
    };
  },
});

export const sendDigestNow = createTool({
  id: 'send_digest_now',
  description:
    'Immediately run a job search for the saved profile and email the digest to the user. ' +
    'Use this when the user asks to preview their notifications or get matches right now. ' +
    'Requires a saved profile with an email address.',
  inputSchema: z.object({}),
  execute: async () => {
    reportStatus('Running a search and emailing your digest…');
    const id = currentSubscriberId();
    const sub = await getSubscription(id);
    if (!sub) return { ok: false, reason: 'No saved profile yet.' };
    if (!sub.email) return { ok: false, reason: 'No email address saved.' };
    if (!(await isEmailConfigured())) {
      return {
        ok: false,
        reason: 'Email is not configured. Add a Resend API key in the Settings panel (gear icon, top right), or set RESEND_API_KEY.',
      };
    }
    try {
      const result = await runDigest(sub, { force: true });
      if (!result.sent) {
        return {
          ok: true,
          sent: false,
          reason: 'No new matches since your last digest, so nothing was emailed (I skip jobs already sent).',
        };
      }
      return { ok: true, sent: true, sentTo: sub.email, newMatches: result.newCount };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
});

/** Text handed back to the model for one fetched page. */
const FETCH_MAX_CHARS = 8000;

export const webFetch = createTool({
  id: 'web_fetch',
  description:
    'Open a single http(s) URL and return its readable text. Use it to check a job posting found via ' +
    'web search, to read the full requirements, or to find the direct apply link on a listing page. ' +
    'Always pass expectedTitle (and expectedCompany when you know it) so the result can tell you ' +
    'whether the page really is that posting: many boards answer an unknown or expired job id with ' +
    'their generic careers page, and applicant-tracking systems like Ashby and Workday render their ' +
    'postings in the browser, so a 200 response on its own proves nothing. Read contentConfirmed, not ' +
    'just the status.',
  inputSchema: z.object({
    url: z.string().describe('Absolute http(s) URL to open, exactly as returned by web search.'),
    expectedTitle: z
      .string()
      .optional()
      .describe('The job title you expect this page to be about, e.g. "Senior Backend Engineer".'),
    expectedCompany: z
      .string()
      .optional()
      .describe('The company you expect this posting to belong to, e.g. "SumUp".'),
  }),
  execute: async ({ url, expectedTitle, expectedCompany }) => {
    reportStatus(`Opening ${hostOf(url)} to check the posting…`);
    const page = await fetchPage(url);
    console.log(`[web_fetch] ${page.completed ? page.status : 'failed'} ${url}`);
    if (!page.completed) {
      return {
        ok: false,
        url,
        error: page.error,
        contentConfirmed: false,
        confirmation:
          'The page could not be fetched (timeout, block, or network error). This does NOT mean the ' +
          'posting is gone — do not claim it is closed, and say it is unconfirmed.',
      };
    }

    const notFound = page.status === 404 || page.status === 410;
    const text = page.text.slice(0, FETCH_MAX_CHARS);
    const result = {
      ok: page.status >= 200 && page.status < 400,
      status: page.status,
      url: page.url,
      // Only these two signals justify calling a posting closed.
      postingGone: notFound || looksClosed(page.text),
      truncated: page.text.length > text.length,
      text,
    };

    return { ...result, ...confirmContent(page, url, expectedTitle, expectedCompany, notFound) };
  },
});

/**
 * Decide whether the fetched page actually backs up the posting the model is
 * about to present, and say why in words the model can repeat to the user.
 *
 * Deliberately conservative: `contentConfirmed: false` means "not proven", not
 * "fake". Genuine postings on browser-rendered boards can never be confirmed
 * this way, so the prompt asks the model to show them and label them unconfirmed
 * rather than drop them.
 */
function confirmContent(
  page: FetchedPage,
  requestedUrl: string,
  expectedTitle: string | undefined,
  expectedCompany: string | undefined,
  notFound: boolean,
): { contentConfirmed: boolean; confirmation: string } {
  const body = page.text;
  if (notFound) {
    return { contentConfirmed: false, confirmation: 'The page is a 404/410 — this posting is gone.' };
  }
  const lostId = lostPostingId(requestedUrl, page.url);
  if (lostId) {
    return {
      contentConfirmed: false,
      confirmation:
        `The link redirected to ${page.url}, dropping the posting id "${lostId}" — this is what a board ` +
        'does when a job id is unknown or expired, so the role is almost certainly not open at this URL. ' +
        'Do not present it as that role\'s apply link; at most offer it as the company\'s job board.',
    };
  }
  if (body.length < MIN_CONTENT_CHARS) {
    return {
      contentConfirmed: false,
      confirmation:
        `The page returned almost no readable text (${body.length} characters), which means it renders ` +
        'in the browser (typical of Ashby and Workday). Nothing could be confirmed: present it only if ' +
        'web search gave you this exact URL, and tell the user you could not open it to check.',
    };
  }
  if (!expectedTitle && !expectedCompany) {
    return {
      contentConfirmed: false,
      confirmation:
        'Nothing to check against — no expectedTitle or expectedCompany was passed. Call web_fetch ' +
        'again with them if you want this posting confirmed.',
    };
  }

  const titleOk = expectedTitle ? mentionsPhrase(body, expectedTitle) : null;
  const companyOk = expectedCompany ? mentionsPhrase(body, expectedCompany) : null;

  if (titleOk === false) {
    return {
      contentConfirmed: false,
      confirmation:
        `The page does not mention "${expectedTitle}" — either this URL is not that posting (boards serve ` +
        'a generic listing page for an unknown or expired job id) or the title you expected is wrong. ' +
        'Either way, do not present this as a direct link to that role.',
    };
  }
  if (companyOk === false) {
    return {
      contentConfirmed: false,
      confirmation: `The page does not mention "${expectedCompany}", so this may not be that company's posting.`,
    };
  }
  const checked = [expectedTitle && 'title', expectedCompany && 'company'].filter(Boolean).join(' and ');
  return {
    contentConfirmed: true,
    confirmation: `The page is live and its text matches the expected ${checked}.`,
  };
}

const APPLICATION_STATUSES = ['applied', 'interviewing', 'offer', 'rejected', 'withdrawn'] as const;

export const markApplied = createTool({
  id: 'mark_applied',
  description:
    'Record that the user applied to a posting, or update one already recorded. Call it whenever they ' +
    'say they applied ("I applied to the SumUp one", "applied to #2"), and again with a new status when ' +
    'they report an outcome ("I got an interview at X", "rejected by Y"). Pass the URL, title and ' +
    'company exactly as you presented them — the URL is the posting\'s identity, so re-recording the ' +
    'same URL updates that entry instead of adding a duplicate. Never guess a URL: if you are not sure ' +
    'which posting the user means, ask them first.',
  inputSchema: z.object({
    url: z.string().optional().describe('The posting URL, verbatim. Strongly preferred — it is the identity of the application.'),
    title: z.string().optional().describe('Job title, e.g. "Senior Backend Engineer".'),
    company: z.string().optional().describe('Company name.'),
    location: z.string().optional().describe('Location as advertised, e.g. "Berlin (remote)".'),
    status: z
      .enum(APPLICATION_STATUSES)
      .optional()
      .describe('Defaults to "applied". Use interviewing/offer/rejected/withdrawn to record an outcome later.'),
    notes: z.string().optional().describe('Anything the user mentioned: referral, salary, recruiter name, next step.'),
  }),
  execute: async (input) => {
    if (!input.url && !(input.title && input.company)) {
      return {
        ok: false,
        reason: 'Need either the posting URL, or both a title and a company, to record an application.',
      };
    }
    reportStatus('Recording your application…');
    const id = currentSubscriberId();
    const { application, created } = await recordApplication(id, input, Date.now());
    return {
      ok: true,
      created,
      updated: !created,
      application: describeApplication(application),
    };
  },
});

export const listApplied = createTool({
  id: 'list_applications',
  description:
    'List the postings the user has told you they applied to, most recent first. Use it whenever they ' +
    'ask what they applied to, how many, or where things stand. Also worth calling before presenting ' +
    'new matches, so you do not offer a role they already applied to.',
  inputSchema: z.object({
    status: z
      .enum(APPLICATION_STATUSES)
      .optional()
      .describe('Only return applications in this state. Omit for all of them.'),
    limit: z.number().int().positive().max(200).optional().describe('Maximum entries to return (default 100).'),
  }),
  execute: async ({ status, limit }) => {
    reportStatus('Checking your application history…');
    const id = currentSubscriberId();
    const applications = await listApplications(id, limit ?? 100, status as ApplicationStatus | undefined);
    return {
      ok: true,
      count: applications.length,
      applications: applications.map(describeApplication),
    };
  },
});

/**
 * Shape an application for the model: the stored timestamps are epoch millis,
 * which it cannot read, so send an ISO date and a plain-English age alongside.
 */
function describeApplication(app: Application) {
  return {
    title: app.title,
    company: app.company,
    location: app.location,
    url: app.url,
    status: app.status,
    notes: app.notes,
    appliedOn: new Date(app.appliedAt).toISOString().slice(0, 10),
    appliedDaysAgo: Math.floor((Date.now() - app.appliedAt) / 86_400_000),
  };
}

export const tools = {
  save_profile: saveProfile,
  set_preferences: setPreferences,
  get_profile: getProfile,
  send_digest_now: sendDigestNow,
  web_fetch: webFetch,
  mark_applied: markApplied,
  list_applications: listApplied,
};
