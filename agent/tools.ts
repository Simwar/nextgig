/**
 * Tools the nextgig agent uses during onboarding and on demand.
 *
 * Web search itself is provided by Anthropic's native server-side web_search
 * tool (wired in agent/index.ts) — it reuses ANTHROPIC_API_KEY, so there is no
 * separate jobs-API key. These tools persist what the model learns and let the
 * user trigger an immediate digest.
 */

import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { currentSubscriberId } from './context';
import {
  getSubscription,
  upsertSubscription,
  type RemotePreference,
  type Cadence,
} from './db';
import { runDigest } from './scheduler';
import { isEmailConfigured } from './email';

const skillSchema = z.object({
  name: z.string().describe('Skill name, e.g. "TypeScript", "Kubernetes", "Product strategy".'),
  level: z
    .string()
    .describe('Proficiency: "expert", "advanced", "intermediate", or "beginner".'),
  years: z.number().optional().describe('Approximate years of experience, if known.'),
});

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
    const id = currentSubscriberId();
    const sub = await upsertSubscription(id, {
      matrix: { headline, targetTitles, skills, notes },
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

export const tools = {
  save_profile: saveProfile,
  set_preferences: setPreferences,
  get_profile: getProfile,
  send_digest_now: sendDigestNow,
};
