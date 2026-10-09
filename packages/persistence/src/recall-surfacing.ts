/** Minimal, owner-scoped identity for context that was surfaced in a reply. */
export interface RecallSurfaceRef {
  /** Opaque stable key derived from trusted source IDs; never a label or excerpt. */
  sourceKey: string;
  sourceRevision: string | null;
  kind: string;
  /** Source row identities used only for an atomic stale/hidden-source check. */
  sourceMessageIds?: string[];
  representation?: string;
}

export interface RecallSurfaceRecord {
  id: string;
  agentId: string;
  sourceKey: string;
  sourceRevision: string | null;
  kind: string;
  firstSurfacedAt: Date;
  lastSurfacedAt: Date;
  lastMessageId: string | null;
  surfaceCount: number;
  suppressedAt: Date | null;
  version: number;
}

export interface RecallSurfacingRepository {
  readonly kind: 'recall-surfacing-repository';
  /** Returns the subset currently hidden by this owner. Missing storage must fail closed. */
  suppressed(
    agentId: string,
    sourceKeys: string[],
    currentRevisions?: Readonly<Record<string, string | null>>,
  ): Promise<Set<string>>;
  /** Called in the same transaction as assistant-message persistence. */
  recordSurfaced(input: {
    agentId: string;
    messageId: string;
    refs: RecallSurfaceRef[];
    now?: Date;
  }): Promise<void>;
  /** Owner control; expectedVersion prevents a stale client from overwriting a newer choice. */
  setSuppressed(input: {
    agentId: string;
    sourceKey: string;
    suppressed: boolean;
    expectedSourceRevision?: string | null;
    expectedVersion?: number;
    now?: Date;
  }): Promise<{ ok: boolean; version?: number }>;
  list(agentId: string, limit?: number): Promise<RecallSurfaceRecord[]>;
}

export function recallSurfaceRefs(parts: unknown): RecallSurfaceRef[] {
  if (!Array.isArray(parts)) return [];
  const refs: RecallSurfaceRef[] = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object' || (part as { type?: unknown }).type !== 'recall')
      continue;
    const sources = (part as { sources?: unknown }).sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const value = source as {
        surfaceKey?: unknown;
        sourceRevision?: unknown;
        kind?: unknown;
        evidence?: unknown;
      };
      if (typeof value.surfaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.surfaceKey))
        continue;
      const evidence =
        value.evidence && typeof value.evidence === 'object'
          ? (value.evidence as Record<string, unknown>)
          : null;
      const sourceMessageIds = Array.isArray(evidence?.sourceMessageIds)
        ? evidence.sourceMessageIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          )
        : [];
      refs.push({
        sourceKey: value.surfaceKey,
        sourceRevision: typeof value.sourceRevision === 'string' ? value.sourceRevision : null,
        kind: typeof value.kind === 'string' ? value.kind : 'unknown',
        ...(sourceMessageIds.length ? { sourceMessageIds } : {}),
        ...(typeof evidence?.representation === 'string'
          ? { representation: evidence.representation }
          : {}),
      });
    }
  }
  return [...new Map(refs.map((ref) => [ref.sourceKey, ref])).values()];
}
