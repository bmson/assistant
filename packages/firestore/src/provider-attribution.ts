import type { Query, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { decodeRecord, type InstallationStore } from './store.js';

const PAGE_SIZE = 250;
const MAX_PAGES = 20;
const MAX_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

export type ProviderAttributionBucket =
  | 'openai'
  | 'openrouter'
  | 'vertex'
  | 'openai_compatible'
  | 'unknown';

export interface ProviderAttributionReport {
  startUtc: string;
  endUtc: string;
  complete: boolean;
  scannedCount: number;
  pageCount: number;
  counts: Record<ProviderAttributionBucket, number>;
}

interface ModelCallIdentity {
  createdAt?: unknown;
  model?: unknown;
}

function validRange(startUtc: Date, endUtc: Date, now: Date): void {
  if (
    !(startUtc instanceof Date) ||
    !(endUtc instanceof Date) ||
    !(now instanceof Date) ||
    !Number.isFinite(startUtc.getTime()) ||
    !Number.isFinite(endUtc.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    startUtc >= endUtc ||
    endUtc > now ||
    endUtc.getTime() - startUtc.getTime() > MAX_RANGE_MS
  ) {
    throw new Error(
      'Provider attribution range must be a past UTC interval no longer than 31 days',
    );
  }
}

/** Follows connectionIdForModel's provider namespaces without importing core at runtime. */
function providerForModel(model: unknown): ProviderAttributionBucket {
  if (typeof model !== 'string' || model.length === 0 || model.trim() !== model) return 'unknown';
  if (/^vertex[:/].+$/i.test(model)) return 'vertex';
  if (/^openai:.+$/.test(model)) return 'openai';

  const gateway = /^gw:([^:]+):(.+)$/.exec(model);
  if (gateway) {
    return /^[a-z0-9][a-z0-9-]{0,39}$/.test(gateway[1] ?? '') ? 'openai_compatible' : 'unknown';
  }
  if (model.startsWith('gw:') || model === 'openai:' || /^vertex[:/]$/i.test(model))
    return 'unknown';

  // Existing unprefixed model IDs are OpenRouter identities in the router contract.
  return 'openrouter';
}

/**
 * Bounded, private ledger attribution read. Caller owns authorization and only
 * receives aggregate counts; this helper is deliberately not package-exported.
 */
export async function readProviderAttribution(input: {
  store: InstallationStore;
  startUtc: Date;
  endUtc: Date;
}): Promise<ProviderAttributionReport> {
  validRange(input.startUtc, input.endUtc, input.store.now());
  const startUtc = new Date(input.startUtc.getTime());
  const endUtc = new Date(input.endUtc.getTime());
  const startUtcIso = startUtc.toISOString();
  const endUtcIso = endUtc.toISOString();

  const counts: Record<ProviderAttributionBucket, number> = {
    openai: 0,
    openrouter: 0,
    vertex: 0,
    openai_compatible: 0,
    unknown: 0,
  };
  const baseQuery = input.store
    .collection('modelCalls')
    .where('createdAt', '>=', startUtc)
    .where('createdAt', '<', endUtc)
    .orderBy('createdAt')
    .select('createdAt', 'model');

  const query: Query = baseQuery;
  let cursor: QueryDocumentSnapshot | undefined;
  let scannedCount = 0;
  let pageCount = 0;

  for (; pageCount < MAX_PAGES; pageCount += 1) {
    const page = await (cursor ? query.startAfter(cursor) : query).limit(PAGE_SIZE).get();
    for (const document of page.docs) {
      const row = decodeRecord<ModelCallIdentity>(document.data());
      if (
        !(row.createdAt instanceof Date) ||
        !Number.isFinite(row.createdAt.getTime()) ||
        row.createdAt < startUtc ||
        row.createdAt >= endUtc
      ) {
        throw new Error('Provider attribution row is outside the requested UTC interval');
      }
      counts[providerForModel(row.model)] += 1;
      scannedCount += 1;
    }

    if (page.size < PAGE_SIZE) {
      return {
        startUtc: startUtcIso,
        endUtc: endUtcIso,
        complete: true,
        scannedCount,
        pageCount: pageCount + 1,
        counts,
      };
    }
    cursor = page.docs.at(-1);
  }

  return {
    startUtc: startUtcIso,
    endUtc: endUtcIso,
    complete: false,
    scannedCount,
    pageCount,
    counts,
  };
}
