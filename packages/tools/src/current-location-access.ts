import type { ToolContext } from './types.js';

/** Public provider access does not authorize reading the owner's private ping. */
export function canUseOwnerCurrentLocation(ctx: Pick<ToolContext, 'trust' | 'tainted'>): boolean {
  return (ctx.trust === 'owner' || ctx.trust === 'assistant') && !ctx.tainted;
}
