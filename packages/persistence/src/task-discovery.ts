import { createHash } from 'node:crypto';
import type { ActivityTaskRecord } from './task-activity.js';

export class TaskDiscoveryInputError extends Error {}

export type TaskDiscoveryRow = Omit<ActivityTaskRecord, 'trigger'> & {
  createdAt: Date | null;
  conversationId: string | null;
  source: string;
  externalEventId: string | null;
  /** Internal scan row that advances Firestore pagination but is never projected. */
  suppressed?: boolean;
};
export interface TaskDiscoveryCursor {
  at: Date;
  id: string;
}
export interface TaskDiscoveryRepository {
  readonly driver: 'postgres' | 'firestore';
  scan(
    agentId: string,
    input: { after?: TaskDiscoveryCursor; limit: number },
  ): Promise<{
    rows: TaskDiscoveryRow[];
    hasMore: boolean;
    archivedCount: number;
    pendingApprovalTaskIds: string[];
  }>;
}
export interface TaskDiscoveryInput {
  archived: boolean;
  filter: 'all' | 'needs-you' | 'working' | 'scheduled' | 'completed';
  q?: string;
  type?: string;
  trust?: string;
  source?: string;
  from?: string;
  until?: string;
  cursor?: string;
  limit?: number;
}
export function discoveryInput(input: TaskDiscoveryInput): TaskDiscoveryInput {
  if (
    !['all', 'needs-you', 'working', 'scheduled', 'completed'].includes(input.filter) ||
    typeof input.archived !== 'boolean'
  )
    throw new TaskDiscoveryInputError('Invalid discovery filters');
  for (const key of ['q', 'type', 'trust', 'source'] as const) {
    if (
      input[key] !== undefined &&
      (typeof input[key] !== 'string' || input[key].length > (key === 'q' ? 200 : 100))
    )
      throw new TaskDiscoveryInputError('Discovery filter is too long');
  }
  for (const key of ['from', 'until'] as const)
    if (
      input[key] &&
      (!/^\d{4}-\d{2}-\d{2}T/.test(input[key]) || !Number.isFinite(new Date(input[key]).getTime()))
    )
      throw new TaskDiscoveryInputError('Discovery dates must be ISO timestamps');
  if (input.from && input.until && new Date(input.from) > new Date(input.until))
    throw new TaskDiscoveryInputError('Discovery date range is inverted');
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
  )
    throw new TaskDiscoveryInputError('Discovery page limit must be 1 to 100');
  return {
    ...input,
    q: input.q?.trim() || undefined,
    type: input.type || undefined,
    trust: input.trust || undefined,
    source: input.source || undefined,
    from: input.from ? new Date(input.from).toISOString() : undefined,
    until: input.until ? new Date(input.until).toISOString() : undefined,
  };
}
function scope(agentId: string, driver: string, input: TaskDiscoveryInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        agentId,
        driver,
        input.archived,
        input.filter,
        input.q ?? '',
        input.type ?? '',
        input.trust ?? '',
        input.source ?? '',
        input.from ?? '',
        input.until ?? '',
      ]),
    )
    .digest('hex');
}
export function encodeDiscoveryCursor(
  agentId: string,
  driver: string,
  input: TaskDiscoveryInput,
  cursor: TaskDiscoveryCursor,
): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scope: scope(agentId, driver, input),
      at: cursor.at.toISOString(),
      id: cursor.id,
    }),
  ).toString('base64url');
}
export function decodeDiscoveryCursor(
  agentId: string,
  driver: string,
  input: TaskDiscoveryInput,
): TaskDiscoveryCursor | undefined {
  if (!input.cursor) return undefined;
  if (input.cursor.length > 2000) throw new TaskDiscoveryInputError('Invalid discovery cursor');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    throw new TaskDiscoveryInputError('Invalid discovery cursor');
  }
  if (
    value?.v !== 1 ||
    value.scope !== scope(agentId, driver, input) ||
    typeof value.at !== 'string' ||
    !Number.isFinite(new Date(value.at).getTime()) ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 300 ||
    (driver === 'postgres' &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id))
  )
    throw new TaskDiscoveryInputError('Discovery cursor belongs to another owner or filter');
  return { at: new Date(value.at), id: value.id };
}
export function matchesTaskDiscovery(row: TaskDiscoveryRow, input: TaskDiscoveryInput): boolean {
  if (
    (row.archivedAt !== null) !== input.archived ||
    (input.type && row.type !== input.type) ||
    (input.trust && row.trust !== input.trust) ||
    (input.source && row.source !== input.source)
  )
    return false;
  const statuses =
    input.filter === 'needs-you'
      ? ['waiting_approval', 'waiting_budget', 'needs_attention']
      : input.filter === 'working'
        ? ['pending', 'running']
        : input.filter === 'scheduled'
          ? ['sleeping', 'waiting_event']
          : input.filter === 'completed'
            ? ['done', 'failed', 'cancelled']
            : null;
  if (statuses && !statuses.includes(row.status)) return false;
  if ((input.from || input.until) && !row.createdAt) return false;
  if (input.from && row.createdAt && row.createdAt < new Date(input.from)) return false;
  if (input.until && row.createdAt && row.createdAt > new Date(input.until)) return false;
  return (
    !input.q ||
    [row.id, row.title, row.progress, row.conversationId, row.externalEventId]
      .join(' ')
      .toLowerCase()
      .includes(input.q.toLowerCase())
  );
}
