/**
 * Email delivery for scheduled job-match digests, via Resend.
 *
 * Resend needs just one API key — no SMTP, no app passwords, no 2FA, and it's
 * unaffected by Google Workspace policies. The key can come from the
 * RESEND_API_KEY env var (preferred for production, via `ast secrets`) or be
 * set at runtime from the app's Settings panel (stored in ./data). Env wins.
 *
 * Sending uses the Resend REST API directly (fetch) — no extra dependency.
 * Until a domain is verified in Resend, the default sender onboarding@resend.dev
 * can only email your own Resend account address; verify a domain (or set
 * RESEND_FROM) to email arbitrary recipients.
 */

import { getSetting, setSetting } from './settings';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Job Hunter <onboarding@resend.dev>';

const KEY_SETTING = 'resend_api_key';
const FROM_SETTING = 'resend_from';

export type ConfigSource = 'env' | 'stored' | 'none';

async function resolveApiKey(): Promise<{ key: string; source: ConfigSource }> {
  if (process.env.RESEND_API_KEY) return { key: process.env.RESEND_API_KEY, source: 'env' };
  const stored = await getSetting(KEY_SETTING);
  if (stored) return { key: stored, source: 'stored' };
  return { key: '', source: 'none' };
}

async function resolveFrom(): Promise<string> {
  return process.env.RESEND_FROM || (await getSetting(FROM_SETTING)) || DEFAULT_FROM;
}

/** True when an API key is available (from env or stored settings). */
export async function isEmailConfigured(): Promise<boolean> {
  return Boolean((await resolveApiKey()).key);
}

export interface EmailStatus {
  configured: boolean;
  source: ConfigSource;
  from: string;
  /** True when the sender still uses the shared onboarding@resend.dev address. */
  usingDefaultFrom: boolean;
}

export async function emailStatus(): Promise<EmailStatus> {
  const { key, source } = await resolveApiKey();
  const from = await resolveFrom();
  return { configured: Boolean(key), source, from, usingDefaultFrom: from === DEFAULT_FROM };
}

/**
 * Persist operator email settings entered from the UI. Only non-empty values
 * are written; passing an empty apiKey leaves the stored key untouched (so the
 * UI can save a From change without re-entering the key).
 */
export async function saveEmailSettings(opts: { apiKey?: string; from?: string }): Promise<void> {
  if (opts.apiKey && opts.apiKey.trim()) await setSetting(KEY_SETTING, opts.apiKey.trim());
  if (opts.from !== undefined) await setSetting(FROM_SETTING, opts.from.trim());
}

export interface SendArgs {
  to: string;
  subject: string;
  /** Plain-text body. */
  text: string;
  /** Optional pre-rendered HTML; falls back to a <pre> wrap of `text`. */
  html?: string;
}

/** Send an email via Resend. Throws with Resend's own error message on failure. */
export async function sendEmail(args: SendArgs): Promise<void> {
  const { key } = await resolveApiKey();
  if (!key) {
    throw new Error(
      'Email is not configured. Add a Resend API key via the app Settings panel or the RESEND_API_KEY secret.',
    );
  }
  const from = await resolveFrom();
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [args.to],
      subject: args.subject,
      text: args.text,
      html: args.html ?? `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(args.text)}</pre>`,
    }),
  });

  if (!res.ok) {
    let detail = `Resend returned HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; name?: string };
      if (body?.message) detail = body.message;
    } catch {
      // non-JSON error body — keep the status-based message
    }
    throw new Error(detail);
  }
}

/** Send a small confirmation email so the operator can verify setup end-to-end. */
export async function sendTestEmail(to: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'Job Hunter — email is working ✅',
    text:
      'This is a test from your Job Hunter agent. If you received it, scheduled job-match ' +
      'digests will be delivered here.',
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
