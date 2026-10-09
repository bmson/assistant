import { createHash } from 'node:crypto';
import type { ToolContext } from './types.js';

/** Display/content equality is never operation equality when a durable call exists. */
export function toolOperationKey(kind: string, ctx: ToolContext, legacy: string): string {
  if (!ctx.operationId) return legacy;
  return `${kind}:operation:${createHash('sha256')
    .update(JSON.stringify([ctx.agentId, ctx.taskId, kind, ctx.operationId]))
    .digest('hex')}`;
}
