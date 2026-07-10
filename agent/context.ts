/**
 * Per-message request context.
 *
 * Mastra runs tool `execute` callbacks inside the same async context as the
 * adapter's stream() call, so we use AsyncLocalStorage to make the current
 * conversation/user available to tools without threading it through args.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  conversationId?: string;
  userId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Stable id used to key a subscription to the current chatter. Prefers the
 * authenticated userId, falls back to the conversationId, then a constant so
 * local single-user playground sessions still work.
 */
export function currentSubscriberId(): string {
  const ctx = requestContext.getStore();
  return ctx?.userId || ctx?.conversationId || 'default';
}
