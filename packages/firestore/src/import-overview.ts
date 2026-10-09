import type {
  ImportOverviewData,
  ImportOverviewRepository,
  ImportSourcePathsInput,
  ImportSourcesPageInput,
  Records,
} from '@assistant/persistence';
import type { Query, QueryDocumentSnapshot } from '@google-cloud/firestore';
import { assertPrivacyErasureFenceUnchanged, readPrivacyErasureFence } from './privacy-erasure.js';
import { decodeRecord, documentKey, type InstallationStore } from './store.js';

const MAX_PAGE_SIZE = 50;
const MAX_SOURCE_SCAN = 1_000;
const MAX_SOURCE_PATH_LOOKUP = 50;

function ownedSource(doc: QueryDocumentSnapshot, agentId: string): Records['importSources'] {
  const source = decodeRecord<Records['importSources']>(doc.data());
  if (
    !source.id ||
    documentKey(source.id) !== doc.id ||
    source.agentId !== agentId ||
    !(source.createdAt instanceof Date) ||
    !(source.updatedAt instanceof Date) ||
    typeof source.source !== 'string' ||
    typeof source.workspacePath !== 'string'
  )
    throw new Error('Malformed or foreign import source record');
  return source;
}

/** Bounded owner import metadata and quarantine counts for workspace views. */
export class FirestoreImportOverviewRepository implements ImportOverviewRepository {
  readonly kind = 'import-overview-repository' as const;

  constructor(
    readonly store: InstallationStore,
    readonly configuredAgentId: string,
  ) {}

  async listPage(input: ImportSourcesPageInput): Promise<ImportOverviewData> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE)
      throw new Error('Import source page size must be between 1 and 50');
    if (
      input.afterSource !== undefined &&
      (input.afterSource.length === 0 || input.afterSource.length > 500)
    )
      throw new Error('Invalid import source continuation');
    if (
      input.excludeSourcePrefix !== undefined &&
      (input.excludeSourcePrefix.length === 0 || input.excludeSourcePrefix.length > 100)
    )
      throw new Error('Invalid excluded import source prefix');
    const agent = await this.store.doc('agents', this.configuredAgentId).get();
    if (!agent.exists || agent.get('id') !== this.configuredAgentId)
      throw new Error('Configured Firestore agent is missing or malformed');
    const fence = await readPrivacyErasureFence(this.store, this.configuredAgentId);
    const sourceQuery = this.store
      .collection('importSources')
      .where('agentId', '==', this.configuredAgentId)
      .orderBy('source', 'asc') as Query;
    const query = input.afterSource ? sourceQuery.startAfter(input.afterSource) : sourceQuery;
    // Scan a bounded number of ordered source rows so omitted classes (for example
    // voice-sample imports) never consume a visible page or hide later history.
    const sourceSnapshot = await query.limit(MAX_SOURCE_SCAN + 1).get();
    const sources: Records['importSources'][] = [];
    let lastScannedSource: string | null = null;
    let foundVisibleOverflow = false;
    for (const doc of sourceSnapshot.docs.slice(0, MAX_SOURCE_SCAN)) {
      const source = ownedSource(doc, this.configuredAgentId);
      if (input.excludeSourcePrefix && source.source.startsWith(input.excludeSourcePrefix)) {
        lastScannedSource = source.source;
        continue;
      }
      if (sources.length === input.limit) {
        foundVisibleOverflow = true;
        break;
      }
      sources.push(source);
      lastScannedSource = source.source;
    }
    const quarantineCounts = new Map<string, number>();
    await Promise.all(
      sources.map(async (source) => {
        const query = this.store
          .collection('memories')
          .where('agentId', '==', this.configuredAgentId)
          .where('source', '==', source.source)
          .where('quarantined', '==', true);
        const result = await query.count().get();
        const count = result.data().count;
        if (!Number.isSafeInteger(count) || count < 0)
          throw new Error('Malformed import quarantine count');
        if (count > 0) quarantineCounts.set(source.source, count);
      }),
    );
    await assertPrivacyErasureFenceUnchanged(this.store, this.configuredAgentId, fence);
    const hasMore = foundVisibleOverflow || sourceSnapshot.size > MAX_SOURCE_SCAN;
    return {
      sources,
      quarantineBySource: Object.fromEntries(quarantineCounts),
      hasMore,
      nextCursor: hasMore ? lastScannedSource : null,
    };
  }

  async trackedWorkspacePaths(input: ImportSourcePathsInput): Promise<string[]> {
    if (input.workspacePaths.length > MAX_SOURCE_PATH_LOOKUP)
      throw new Error('Import workspace path lookup exceeds its explicit bound');
    if (input.workspacePaths.length === 0) return [];
    const agent = await this.store.doc('agents', this.configuredAgentId).get();
    if (!agent.exists || agent.get('id') !== this.configuredAgentId)
      throw new Error('Configured Firestore agent is missing or malformed');
    const fence = await readPrivacyErasureFence(this.store, this.configuredAgentId);
    const paths: string[] = [];
    for (let offset = 0; offset < input.workspacePaths.length; offset += 30) {
      const batch = input.workspacePaths.slice(offset, offset + 30);
      const snapshot = await this.store
        .collection('importSources')
        .where('agentId', '==', this.configuredAgentId)
        .where('workspacePath', 'in', batch)
        .get();
      for (const doc of snapshot.docs) {
        const row = ownedSource(doc, this.configuredAgentId);
        if (!batch.includes(row.workspacePath)) throw new Error('Malformed tracked import path');
        paths.push(row.workspacePath);
      }
    }
    await assertPrivacyErasureFenceUnchanged(this.store, this.configuredAgentId, fence);
    return paths;
  }
}
