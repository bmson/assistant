import { createHash } from 'node:crypto';
import { parseExactTimestamp } from './exact-timestamp.js';
import { toolCallReceiptKeyId } from './tool-call-receipts.js';

/**
 * Complete installation coverage for the PostgreSQL schema. Adding a table to
 * the schema must also add its ownership, identity, and Firestore representation
 * here so a manifest cannot claim completeness while silently omitting it.
 */
export const MIGRATION_TABLES = [
  { table: 'agents', collection: 'agents', id: 'id', scope: 'agent' },
  { table: 'ambient_snapshots', collection: 'ambientSnapshots', id: 'id', scope: 'agent' },
  { table: 'anomalies', collection: 'anomalies', id: 'id', scope: 'agent' },
  {
    table: 'application_confirmations',
    collection: 'applicationConfirmations',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'assistant_health_alerts',
    collection: 'assistantHealthAlerts',
    id: 'id',
    scope: 'agent',
  },
  { table: 'budgets', collection: 'budgets', id: 'scope', scope: 'installation' },
  {
    table: 'calendar_event_snapshots',
    collection: 'calendarEventSnapshots',
    id: 'id',
    scope: 'agent',
  },
  { table: 'call_sessions', collection: 'callSessions', id: 'id', scope: 'agent' },
  { table: 'canary_runs', collection: 'canaryRuns', id: 'id', scope: 'installation' },
  { table: 'contacts', collection: 'contacts', id: 'id', scope: 'agent' },
  { table: 'conversations', collection: 'conversations', id: 'id', scope: 'agent' },
  { table: 'channel_bindings', collection: 'channelBindings', id: 'id', scope: 'conversation' },
  { table: 'messages', collection: 'messages', id: 'id', scope: 'conversation' },
  { table: 'mission_reports', collection: 'missionReports', id: 'id', scope: 'agent' },
  { table: 'commitments', collection: 'commitments', id: 'id', scope: 'agent' },
  { table: 'conversation_segments', collection: 'conversationSegments', id: 'id', scope: 'agent' },
  { table: 'tasks', collection: 'tasks', id: 'id', scope: 'agent' },
  { table: 'tool_calls', collection: 'toolCalls', id: 'id', scope: 'agent' },
  {
    table: 'tool_call_receipt_keys',
    collection: 'toolCallReceiptKeys',
    id: 'id',
    scope: 'agent',
  },
  { table: 'tool_call_receipts', collection: 'toolCallReceipts', id: 'id', scope: 'agent' },
  { table: 'approvals', collection: 'approvals', id: 'id', scope: 'agent' },
  { table: 'approval_policies', collection: 'approvalPolicies', id: 'id', scope: 'agent' },
  { table: 'cost_events', collection: 'costEvents', id: 'id', scope: 'installation' },
  { table: 'cost_reservations', collection: 'costReservations', id: 'id', scope: 'installation' },
  { table: 'device_tokens', collection: 'deviceTokens', id: 'id', scope: 'agent' },
  { table: 'document_chunks', collection: 'documentChunks', id: 'id', scope: 'agent' },
  { table: 'documents', collection: 'documents', id: 'id', scope: 'agent' },
  { table: 'dream_notes', collection: 'dreamNotes', id: 'id', scope: 'agent' },
  {
    table: 'email_attachment_custodies',
    collection: 'emailAttachmentCustodies',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'email_booking_occurrences',
    collection: 'emailBookingOccurrences',
    id: 'id',
    scope: 'agent',
  },
  { table: 'email_ingest', collection: 'emailIngest', id: 'id', scope: 'agent' },
  {
    table: 'email_observer_budgets',
    collection: 'emailObserverBudgets',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'email_observer_sources',
    collection: 'emailObserverSources',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'email_observer_work',
    collection: 'emailObserverWork',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'security_incidents',
    collection: 'securityIncidents',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'security_incident_sources',
    collection: 'securityIncidentSources',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'security_incident_attention',
    collection: 'securityIncidentAttention',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'execution_job_callback_receipts',
    collection: 'executionJobCallbackReceipts',
    id: 'idempotency_key',
    scope: 'agent',
  },
  { table: 'files', collection: 'files', id: 'id', scope: 'agent' },
  {
    table: 'generated_card_revisions',
    collection: 'generatedCardRevisions',
    id: 'id',
    scope: 'agent',
  },
  { table: 'generated_cards', collection: 'generatedCards', id: 'id', scope: 'agent' },
  { table: 'gmail_sync_state', collection: 'gmailSyncState', id: 'mailbox', scope: 'installation' },
  { table: 'schedules', collection: 'schedules', id: 'id', scope: 'agent' },
  { table: 'memories', collection: 'memories', id: 'id', scope: 'agent' },
  {
    table: 'memory_embedding_refreshes',
    collection: 'memoryEmbeddingRefreshes',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'memory_import_lineage',
    collection: 'memoryImportLineage',
    id: 'source',
    scope: 'agent',
  },
  {
    table: 'memory_tombstones',
    collection: 'memoryTombstones',
    id: 'content_hash',
    scope: 'agent',
  },
  { table: 'goals', collection: 'goals', id: 'id', scope: 'agent' },
  { table: 'import_sources', collection: 'importSources', id: 'id', scope: 'agent' },
  { table: 'improvement_proposals', collection: 'improvementProposals', id: 'id', scope: 'agent' },
  {
    table: 'knowledge_graph_entities',
    collection: 'knowledgeGraphEntities',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'knowledge_graph_entity_aliases',
    collection: 'knowledgeGraphEntityAliases',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'knowledge_graph_assertions',
    collection: 'knowledgeGraphAssertions',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'knowledge_graph_assertion_evidence',
    collection: 'knowledgeGraphAssertionEvidence',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'knowledge_graph_relations',
    collection: 'knowledgeGraphRelations',
    id: 'id',
    scope: 'agent',
  },
  {
    table: 'knowledge_graph_sources',
    collection: 'knowledgeGraphSources',
    id: 'memory_id',
    scope: 'agent',
  },
  { table: 'location_pings', collection: 'locationPings', id: 'id', scope: 'agent' },
  {
    table: 'maintenance_cursors',
    collection: 'maintenanceCursors',
    id: 'name',
    scope: 'installation',
  },
  { table: 'mcp_connections', collection: 'mcpConnections', id: 'id', scope: 'agent' },
  { table: 'model_call_audit', collection: 'modelCallAudit', id: 'id', scope: 'installation' },
  { table: 'model_calls', collection: 'modelCalls', id: 'id', scope: 'installation' },
  {
    table: 'model_connections',
    collection: 'modelConnections',
    id: 'id',
    scope: 'installation',
  },
  { table: 'model_roles', collection: 'modelRoles', id: 'role', scope: 'installation' },
  {
    table: 'model_role_revisions',
    collection: 'modelRoleRevisions',
    id: 'id',
    scope: 'installation',
  },
  { table: 'models', collection: 'models', id: 'id', scope: 'installation' },
  { table: 'notification_prefs', collection: 'notificationPrefs', id: 'agent_id', scope: 'agent' },
  { table: 'notification_outbox', collection: 'notificationOutbox', id: 'id', scope: 'agent' },
  { table: 'occasions', collection: 'occasions', id: 'id', scope: 'agent' },
  {
    table: 'occasion_import_lineage',
    collection: 'occasionImportLineage',
    id: 'source',
    scope: 'agent',
  },
  { table: 'owner_card', collection: 'ownerCards', id: 'id', scope: 'agent' },
  { table: 'proactive_moments', collection: 'proactiveMoments', id: 'id', scope: 'agent' },
  { table: 'proactive_pings', collection: 'proactivePings', id: 'id', scope: 'agent' },
  { table: 'rate_limits', collection: 'rateLimits', id: 'scope', scope: 'installation' },
  { table: 'rate_table', collection: 'rateTable', id: 'key', scope: 'installation' },
  { table: 'recall_feedback', collection: 'recallFeedback', id: 'id', scope: 'agent' },
  { table: 'recall_surfaces', collection: 'recallSurfaces', id: 'id', scope: 'agent' },
  { table: 'recall_metrics', collection: 'recallMetrics', id: 'id', scope: 'agent' },
  { table: 'response_checks', collection: 'responseChecks', id: 'id', scope: 'agent' },
  { table: 'self_repair_issues', collection: 'selfRepairIssues', id: 'id', scope: 'agent' },
  { table: 'self_maintenance', collection: 'selfMaintenance', id: 'id', scope: 'agent' },
  { table: 'situation_packs', collection: 'situationPacks', id: 'id', scope: 'agent' },
  { table: 'situation_previews', collection: 'situationPreviews', id: 'id', scope: 'agent' },
  { table: 'skills', collection: 'skills', id: 'id', scope: 'agent' },
  {
    table: 'skill_library_revisions',
    collection: 'skillLibraryRevisions',
    id: 'agent_id',
    scope: 'agent',
  },
  { table: 'suggestions', collection: 'suggestions', id: 'id', scope: 'agent' },
  { table: 'tool_cache', collection: 'toolCache', id: 'cache_key', scope: 'installation' },
  { table: 'voice_profile', collection: 'voiceProfile', id: 'id', scope: 'installation' },
  { table: 'watch_fire_effects', collection: 'watchFireEffects', id: 'id', scope: 'agent' },
  { table: 'watch_fires', collection: 'watchFires', id: 'id', scope: 'agent' },
  { table: 'watches', collection: 'watches', id: 'id', scope: 'agent' },
  { table: 'writing_samples', collection: 'writingSamples', id: 'id', scope: 'installation' },
] as const;

export type MigrationTable = (typeof MIGRATION_TABLES)[number]['table'];
export type MigrationCollection = (typeof MIGRATION_TABLES)[number]['collection'];
export type MigrationScope = (typeof MIGRATION_TABLES)[number]['scope'];

export type MigrationTarget = {
  projectId: string;
  databaseId: string;
  installationId: string;
};

export type SerializedValue =
  | null
  | boolean
  | string
  | number
  | SerializedValue[]
  | { [key: string]: SerializedValue }
  | {
      $assistantMigration: [
        'date' | 'timestamp' | 'bytes' | 'bigint' | 'vector',
        string | number[],
      ];
    }
  | { $assistantMigration: ['object', Array<[string, SerializedValue]>] };

export type MigrationRecord = {
  table: MigrationTable;
  collection: MigrationCollection;
  id: string;
  data: Record<string, SerializedValue>;
  checksum: string;
};

export type MigrationManifest = {
  format: 'assistant-workspace-migration';
  /**
   * v1 encoded driver-parsed Dates and therefore cannot recover PostgreSQL
   * microseconds already discarded. It remains readable for old snapshots;
   * final cutover snapshots must be freshly exported as v3.
   */
  formatVersion: 1 | 2 | 3;
  mode: 'preview' | 'export';
  source: {
    kind: 'postgresql';
    agentId: string;
    scope: 'installation';
    snapshot: string;
    exportedAt?: string;
    embeddingSpace?: { provider: string; model: string; dimensions: number; revision: string };
  };
  target: MigrationTarget;
  tables: Record<
    MigrationTable,
    { collection: MigrationCollection; count: number; checksum: string }
  >;
  coverage: { complete: boolean; supportedTables: MigrationTable[]; omittedTables: string[] };
  recordCount: number;
  bundleChecksum: string;
  unsupportedTables: string[];
};

export type MigrationBundle = {
  manifest: MigrationManifest;
  records: MigrationRecord[];
};

export function tableDefinition(table: string) {
  return MIGRATION_TABLES.find((definition) => definition.table === table);
}

/** Stable Firestore document IDs for provenance junctions with composite keys. */
export function compositeMigrationId(
  table: MigrationTable,
  data: Record<string, unknown>,
): string | null {
  const fields =
    table === 'memory_import_lineage'
      ? ['source', 'memoryId']
      : table === 'occasion_import_lineage'
        ? ['source', 'occasionId']
        : undefined;
  if (!fields) return null;
  const values = fields.map((field) => data[field]);
  if (values.some((value) => typeof value !== 'string' || !value))
    throw new Error(`Invalid composite migration identity: ${table}`);
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}

export function assertSupportedMigrationTables(tables: readonly string[]): MigrationTable[] {
  const unique = [...new Set(tables)];
  const unsupported = unique.filter((table) => !tableDefinition(table));
  if (unsupported.length)
    throw new Error(`Unsupported migration tables: ${unsupported.sort().join(', ')}`);
  return unique as MigrationTable[];
}

/** Stable JSON encoding. Only a reserved-key collision needs an object envelope. */
type MigrationComparator = (left: string, right: string) => number;
const legacyMigrationCompare: MigrationComparator = (left, right) => left.localeCompare(right);
export const deterministicMigrationCompare: MigrationComparator = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;

function serializeMigrationValueWith(
  value: unknown,
  compare: MigrationComparator,
): SerializedValue {
  function visit(input: unknown, depth: number): SerializedValue {
    if (depth > 64) throw new Error('Migration value exceeds the nesting limit');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) throw new Error('Cannot migrate a non-finite number');
      return input;
    }
    if (typeof input === 'bigint') return { $assistantMigration: ['bigint', input.toString()] };
    if (input instanceof PreciseMigrationTimestamp)
      return { $assistantMigration: ['timestamp', input.postgresql] };
    if (input instanceof Date) {
      if (!Number.isFinite(input.getTime())) throw new Error('Cannot migrate an invalid date');
      return { $assistantMigration: ['date', input.toISOString()] };
    }
    if (input instanceof Uint8Array)
      return { $assistantMigration: ['bytes', Buffer.from(input).toString('base64')] };
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    if (input && typeof input === 'object') {
      const entries = Object.entries(input)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, visit(item, depth + 1)] as [string, SerializedValue]);
      if (Object.hasOwn(input, '$assistantMigration'))
        return { $assistantMigration: ['object', entries] };
      return Object.fromEntries(entries);
    }
    throw new Error(`Cannot migrate value of type ${typeof input}`);
  }
  return visit(value, 0);
}

/** Legacy v1/v2 encoding. Locale ordering is retained solely for checksum compatibility. */
export function serializeMigrationValue(value: unknown): SerializedValue {
  return serializeMigrationValueWith(value, legacyMigrationCompare);
}

/** Locale-independent encoding for v3 and newer snapshots. */
export function serializeMigrationValueV3(value: unknown): SerializedValue {
  return serializeMigrationValueWith(value, deterministicMigrationCompare);
}

/** Exact PostgreSQL timestamp retained beyond JavaScript Date's millisecond precision. */
export class PreciseMigrationTimestamp extends Date {
  constructor(
    readonly seconds: bigint,
    readonly nanoseconds: number,
    readonly postgresql: string,
  ) {
    super(Number(seconds * 1000n + BigInt(Math.floor(nanoseconds / 1_000_000))));
  }
}

/** Parse the UTC text projection emitted by the PostgreSQL snapshot exporter. */
export function serializeMigrationTimestamp(value: string): SerializedValue {
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:\+00(?::?00)?|Z)?$/.exec(value);
  if (!match) throw new Error(`Invalid PostgreSQL migration timestamp: ${value}`);
  const fraction = match[3] ?? '';
  const canonical = `${match[1]}T${match[2]}.${fraction.padEnd(6, '0')}Z`;
  try {
    parseExactTimestamp(canonical);
  } catch {
    throw new Error(`Invalid PostgreSQL migration timestamp: ${value}`);
  }
  return { $assistantMigration: ['timestamp', canonical] };
}

export function serializeMigrationVector(value: readonly number[]): SerializedValue {
  if (!value.every((item) => typeof item === 'number' && Number.isFinite(item)))
    throw new Error('Cannot migrate a non-finite vector');
  return { $assistantMigration: ['vector', [...value]] };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(serializeMigrationValue(value));
}

export function checksum(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalJsonV3(value: unknown): string {
  return JSON.stringify(serializeMigrationValueV3(value));
}

export function checksumV3(value: unknown): string {
  return createHash('sha256').update(canonicalJsonV3(value)).digest('hex');
}

export function checksumForMigrationVersion(
  value: unknown,
  version: MigrationManifest['formatVersion'],
): string {
  return version >= 3 ? checksumV3(value) : checksum(value);
}

export function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function deserializeMigrationValue(value: SerializedValue): unknown {
  function visit(input: unknown, depth: number): unknown {
    if (depth > 64) throw new Error('Migration value exceeds the nesting limit');
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (Array.isArray(input)) return input.map((item) => visit(item, depth + 1));
    if (!input || typeof input !== 'object') throw new Error('Invalid migration value');
    if (Object.hasOwn(input, '$assistantMigration')) {
      const tag = (input as Record<string, unknown>).$assistantMigration;
      if (Object.keys(input).length !== 1 || !Array.isArray(tag) || tag.length !== 2)
        throw new Error('Malformed migration tag');
      const [type, payload] = tag;
      if (type === 'date' && typeof payload === 'string') {
        const date = new Date(payload);
        if (Number.isFinite(date.getTime()) && date.toISOString() === payload) return date;
      }
      if (type === 'timestamp' && typeof payload === 'string') {
        const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(payload);
        if (match) {
          try {
            const parsed = parseExactTimestamp(payload);
            return new PreciseMigrationTimestamp(
              BigInt(parsed.seconds),
              parsed.nanoseconds,
              payload,
            );
          } catch {
            // Fall through to the malformed-tag error below.
          }
        }
      }
      if (type === 'bytes' && typeof payload === 'string') {
        const bytes = Buffer.from(payload, 'base64');
        if (bytes.toString('base64') === payload) return bytes;
      }
      if (type === 'bigint' && typeof payload === 'string' && /^-?\d+$/.test(payload))
        return BigInt(payload);
      if (
        type === 'vector' &&
        Array.isArray(payload) &&
        payload.every((item) => typeof item === 'number' && Number.isFinite(item))
      )
        return [...payload];
      if (type === 'object' && Array.isArray(payload)) {
        const seen = new Set<string>();
        const entries = payload.map((entry) => {
          if (
            !Array.isArray(entry) ||
            entry.length !== 2 ||
            typeof entry[0] !== 'string' ||
            seen.has(entry[0])
          )
            throw new Error('Malformed migration object tag');
          seen.add(entry[0]);
          return [entry[0], visit(entry[1], depth + 1)];
        });
        // Deliberately do not visit the reconstructed object again: its reserved key is user data.
        return Object.fromEntries(entries);
      }
      throw new Error('Malformed migration tag');
    }
    return Object.fromEntries(
      Object.entries(input).map(([key, item]) => [key, visit(item, depth + 1)]),
    );
  }
  return visit(value, 0);
}

export function validateMigrationBundle(
  bundle: MigrationBundle,
  expected: { sourceAgentId: string; target: MigrationTarget },
): void {
  if (
    bundle.manifest.format !== 'assistant-workspace-migration' ||
    ![1, 2, 3].includes(bundle.manifest.formatVersion)
  )
    throw new Error('Unsupported migration bundle format');
  const manifest = bundle.manifest;
  const versionChecksum = (value: unknown) =>
    checksumForMigrationVersion(value, manifest.formatVersion);
  const versionCanonicalJson = manifest.formatVersion >= 3 ? canonicalJsonV3 : canonicalJson;
  const versionCompare =
    manifest.formatVersion >= 3 ? deterministicMigrationCompare : legacyMigrationCompare;
  if (
    manifest.source.kind !== 'postgresql' ||
    manifest.source.scope !== 'installation' ||
    typeof manifest.source.snapshot !== 'string' ||
    !manifest.source.snapshot.trim() ||
    manifest.mode !== 'export'
  )
    throw new Error('Invalid migration source metadata');
  const selectedTables = Object.keys(manifest.tables).sort();
  if (
    typeof manifest.coverage?.complete !== 'boolean' ||
    !Array.isArray(manifest.coverage.supportedTables) ||
    versionCanonicalJson([...manifest.coverage.supportedTables].sort()) !==
      versionCanonicalJson(selectedTables) ||
    !Array.isArray(manifest.coverage.omittedTables) ||
    manifest.coverage.omittedTables.some(
      (table) => typeof table !== 'string' || selectedTables.includes(table),
    ) ||
    !Array.isArray(manifest.unsupportedTables) ||
    manifest.unsupportedTables.length !== 0
  )
    throw new Error('Invalid migration coverage metadata');
  if (manifest.coverage.complete && manifest.coverage.omittedTables.length)
    throw new Error('Complete migration coverage cannot omit tables');
  if (
    manifest.coverage.complete &&
    (selectedTables.length !== MIGRATION_TABLES.length ||
      MIGRATION_TABLES.some(({ table }) => !selectedTables.includes(table)))
  )
    throw new Error('Complete migration coverage must include every supported table');
  if (
    manifest.source.embeddingSpace &&
    (typeof manifest.source.embeddingSpace.provider !== 'string' ||
      !manifest.source.embeddingSpace.provider ||
      typeof manifest.source.embeddingSpace.model !== 'string' ||
      !manifest.source.embeddingSpace.model ||
      !Number.isSafeInteger(manifest.source.embeddingSpace.dimensions) ||
      manifest.source.embeddingSpace.dimensions < 1 ||
      typeof manifest.source.embeddingSpace.revision !== 'string' ||
      !manifest.source.embeddingSpace.revision)
  )
    throw new Error('Invalid embedding-space provenance');
  if (manifest.coverage.complete) {
    const exportedAtValue = manifest.source.exportedAt ?? '';
    const exportedAt = new Date(exportedAtValue);
    const validExportedAt = Number.isFinite(exportedAt.getTime());
    const canonicalExportedAt =
      validExportedAt &&
      (manifest.formatVersion === 1
        ? exportedAt.toISOString() === exportedAtValue
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(exportedAtValue));
    if (!manifest.source.exportedAt || !validExportedAt || !canonicalExportedAt)
      throw new Error('Complete migration requires a canonical export timestamp');
  }
  if (bundle.manifest.source.agentId !== expected.sourceAgentId)
    throw new Error('Migration source agent does not match the requested workspace');
  if (versionCanonicalJson(bundle.manifest.target) !== versionCanonicalJson(expected.target))
    throw new Error('Migration target identity does not match the requested installation');
  const sorted = [...bundle.records].sort((a, b) =>
    versionCompare(`${a.table}:${a.id}`, `${b.table}:${b.id}`),
  );
  if (bundle.manifest.recordCount !== sorted.length)
    throw new Error('Migration record count mismatch');
  const seen = new Set<string>();
  if (versionChecksum(sorted) !== bundle.manifest.bundleChecksum)
    throw new Error('Migration bundle checksum mismatch');
  for (const record of sorted) {
    const key = `${record.table}:${record.id}`;
    if (seen.has(key)) throw new Error(`Duplicate migration record: ${key}`);
    seen.add(key);
    if (record.checksum !== versionChecksum(record.data))
      throw new Error(`Record checksum mismatch: ${record.table}/${record.id}`);
    if (tableDefinition(record.table)?.collection !== record.collection)
      throw new Error(`Invalid collection mapping for ${record.table}`);
    const definition = tableDefinition(record.table);
    const primary =
      compositeMigrationId(record.table, record.data) ??
      (record.table === 'owner_card' || record.table === 'ambient_snapshots'
        ? expected.sourceAgentId
        : definition?.id === 'content_hash'
          ? record.data.contentHash
          : record.data[snakeToCamel(definition?.id ?? 'id')]);
    if (String(primary ?? '') !== record.id) throw new Error(`Primary ID mismatch: ${key}`);
    const summary = bundle.manifest.tables[record.table];
    for (const value of Object.values(record.data)) deserializeMigrationValue(value);
    if (!summary || summary.collection !== record.collection)
      throw new Error(`Missing table summary: ${record.table}`);
  }
  const vectorRecords = sorted.filter((record) => {
    const value = record.data.embedding;
    const tag =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as { $assistantMigration?: unknown }).$assistantMigration
        : undefined;
    return Array.isArray(tag) && tag[0] === 'vector';
  });
  if (vectorRecords.length && !manifest.source.embeddingSpace)
    throw new Error('Migration vectors require embedding-space provenance');
  for (const record of vectorRecords) {
    const tag = (record.data.embedding as { $assistantMigration: ['vector', number[]] })
      .$assistantMigration;
    if (tag[1].length !== manifest.source.embeddingSpace?.dimensions)
      throw new Error(`Migration vector dimension mismatch: ${record.table}/${record.id}`);
  }
  for (const [table, summary] of Object.entries(bundle.manifest.tables)) {
    if (tableDefinition(table)?.collection !== summary.collection)
      throw new Error(`Unsupported migration table summary: ${table}`);
    const selected = sorted.filter((record) => record.table === table);
    if (summary.count !== selected.length || summary.checksum !== versionChecksum(selected))
      throw new Error(`Table summary mismatch: ${table}`);
  }
  const owner = sorted.find(
    (record) => record.table === 'agents' && record.id === expected.sourceAgentId,
  );
  if (
    !owner ||
    typeof owner.data.name !== 'string' ||
    typeof owner.data.email !== 'string' ||
    typeof owner.data.workspacePrefix !== 'string'
  )
    throw new Error('Source agent is missing required identity fields');
  validateMigrationReferences(sorted, expected.sourceAgentId);
}

/** Validate ownership and required foreign keys before a bundle can be imported. */
export function validateMigrationReferences(
  records: readonly MigrationRecord[],
  sourceAgentId: string,
): void {
  const ids = new Map<string, Set<string>>();
  const linkedRows = new Map<string, MigrationRecord>();
  for (const record of records) {
    const values = ids.get(record.table) ?? new Set<string>();
    values.add(record.id);
    ids.set(record.table, values);
    linkedRows.set(`${record.table}:${record.id}`, record);
  }
  const importSourceTags = new Set(
    records
      .filter((record) => record.table === 'import_sources')
      .map((record) => record.data.source)
      .filter((source): source is string => typeof source === 'string'),
  );
  const compactReceipts = new Map(
    records
      .filter((record) => record.table === 'tool_call_receipts')
      .map((record) => [record.id, record]),
  );
  const compactKeys = records.filter((record) => record.table === 'tool_call_receipt_keys');
  if (!ids.get('agents')?.has(sourceAgentId))
    throw new Error('Migration bundle must include the source agent record');
  if ((ids.get('agents')?.size ?? 0) !== 1)
    throw new Error(
      'Migration bundle must contain exactly one agent for installation-wide records',
    );
  const requireReference = (
    record: MigrationRecord,
    field: string,
    table: MigrationTable,
    required = false,
  ) => {
    const value = record.data[field];
    if (value == null && !required) return;
    if (typeof value !== 'string' || !ids.get(table)?.has(value))
      throw new Error(`Invalid ${record.table}/${record.id} reference ${field}=${String(value)}`);
  };
  const linked = (table: MigrationTable, id: SerializedValue | undefined) =>
    typeof id === 'string' ? linkedRows.get(`${table}:${id}`) : undefined;
  const requireParent = (
    record: MigrationRecord,
    field: string,
    table: MigrationTable,
    parentField: string,
    expectedParent: SerializedValue | undefined,
  ) => {
    if (record.data[field] == null) return;
    const target = linked(table, record.data[field]);
    if (
      !target ||
      typeof expectedParent !== 'string' ||
      target.data[parentField] !== expectedParent
    )
      throw new Error(`Inconsistent ${record.table}/${record.id} parent linkage: ${field}`);
  };
  const directlyOwned = new Set<MigrationTable>([
    'ambient_snapshots',
    'anomalies',
    'application_confirmations',
    'approval_policies',
    'assistant_health_alerts',
    'calendar_event_snapshots',
    'call_sessions',
    'commitments',
    'conversation_segments',
    'conversations',
    'device_tokens',
    'document_chunks',
    'documents',
    'dream_notes',
    'email_booking_occurrences',
    'email_ingest',
    'email_attachment_custodies',
    'email_observer_budgets',
    'email_observer_sources',
    'email_observer_work',
    'files',
    'generated_cards',
    'goals',
    'import_sources',
    'improvement_proposals',
    'knowledge_graph_entities',
    'knowledge_graph_entity_aliases',
    'knowledge_graph_assertions',
    'knowledge_graph_assertion_evidence',
    'knowledge_graph_relations',
    'location_pings',
    'mcp_connections',
    'memories',
    'memory_embedding_refreshes',
    'mission_reports',
    'notification_prefs',
    'occasions',
    'owner_card',
    'proactive_moments',
    'proactive_pings',
    'recall_feedback',
    'recall_metrics',
    'recall_surfaces',
    'schedules',
    'self_maintenance',
    'situation_packs',
    'skills',
    'suggestions',
    'tasks',
    'watch_fires',
    'watch_fire_effects',
    'watches',
    'writing_samples',
  ]);
  for (const record of records) {
    if (
      record.table !== 'agents' &&
      'agentId' in record.data &&
      record.data.agentId !== sourceAgentId
    )
      throw new Error(`Record outside source workspace: ${record.table}/${record.id}`);
    if (directlyOwned.has(record.table)) requireReference(record, 'agentId', 'agents', true);
    if (record.table === 'tool_call_receipts') {
      if (
        record.data.agentId !== sourceAgentId ||
        record.data.toolCallId !== record.id ||
        typeof record.data.taskId !== 'string' ||
        typeof record.data.toolName !== 'string' ||
        !['completed', 'failed', 'unknown', 'not_executed'].includes(
          String(record.data.effectOutcome),
        )
      )
        throw new Error(`Invalid compact tool-call receipt: ${record.id}`);
      for (const field of ['modelToolCallIdHash', 'idempotencyKeyHash'] as const) {
        const value = record.data[field];
        if (value != null && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)))
          throw new Error(`Invalid compact tool-call receipt identity: ${record.id}/${field}`);
        const kind = field === 'modelToolCallIdHash' ? 'model_tool_call' : 'idempotency';
        const matching = compactKeys.filter(
          (candidate) =>
            candidate.data.receiptId === record.id &&
            candidate.data.kind === kind &&
            candidate.data.digest === value,
        );
        if (value != null && matching.length !== 1)
          throw new Error(`Missing compact tool-call receipt key: ${record.id}/${kind}`);
      }
    }
    if (record.table === 'tool_call_receipt_keys') {
      const receipt = compactReceipts.get(String(record.data.receiptId ?? ''));
      const field =
        record.data.kind === 'model_tool_call'
          ? 'modelToolCallIdHash'
          : record.data.kind === 'idempotency'
            ? 'idempotencyKeyHash'
            : null;
      if (
        !receipt ||
        !field ||
        record.data.agentId !== sourceAgentId ||
        record.data.taskId !== receipt.data.taskId ||
        record.data.digest !== receipt.data[field] ||
        record.id !==
          toolCallReceiptKeyId(
            record.data.kind as 'model_tool_call' | 'idempotency',
            String(record.data.digest ?? ''),
          )
      )
        throw new Error(`Invalid compact tool-call receipt key: ${record.id}`);
    }
    if (record.table === 'channel_bindings')
      requireReference(record, 'conversationId', 'conversations', true);
    if (record.table === 'messages') {
      requireReference(record, 'conversationId', 'conversations', true);
      requireReference(record, 'taskId', 'tasks');
    }
    if (record.table === 'execution_job_callback_receipts')
      requireReference(record, 'taskId', 'tasks', true);
    if (record.table === 'situation_previews')
      requireReference(record, 'packId', 'situation_packs', true);
    if (record.table === 'memory_import_lineage') {
      if (typeof record.data.source !== 'string' || !importSourceTags.has(record.data.source))
        throw new Error(
          `Invalid ${record.table}/${record.id} reference source=${String(record.data.source)}`,
        );
      requireReference(record, 'memoryId', 'memories', true);
    }
    if (record.table === 'occasion_import_lineage') {
      if (typeof record.data.source !== 'string' || !importSourceTags.has(record.data.source))
        throw new Error(
          `Invalid ${record.table}/${record.id} reference source=${String(record.data.source)}`,
        );
      requireReference(record, 'occasionId', 'occasions', true);
    }
    if (record.table === 'generated_cards') {
      requireReference(record, 'conversationId', 'conversations');
      requireReference(record, 'messageId', 'messages');
      requireReference(record, 'currentRevisionId', 'generated_card_revisions', true);
      requireParent(record, 'currentRevisionId', 'generated_card_revisions', 'cardId', record.id);
      requireParent(record, 'messageId', 'messages', 'conversationId', record.data.conversationId);
    }
    if (record.table === 'generated_card_revisions')
      requireReference(record, 'cardId', 'generated_cards', true);
    if (record.table === 'commitments') {
      requireReference(record, 'conversationId', 'conversations', true);
      requireReference(record, 'sourceMessageId', 'messages');
      requireReference(record, 'sourceTaskId', 'tasks');
      requireParent(
        record,
        'sourceMessageId',
        'messages',
        'conversationId',
        record.data.conversationId,
      );
    }
    if (record.table === 'conversation_segments') {
      requireReference(record, 'conversationId', 'conversations', true);
      requireReference(record, 'startMessageId', 'messages', true);
      requireReference(record, 'endMessageId', 'messages', true);
      requireParent(
        record,
        'startMessageId',
        'messages',
        'conversationId',
        record.data.conversationId,
      );
      requireParent(
        record,
        'endMessageId',
        'messages',
        'conversationId',
        record.data.conversationId,
      );
    }
    if (record.table === 'mission_reports') {
      requireReference(record, 'missionId', 'tasks', true);
      requireReference(record, 'goalId', 'goals');
      requireReference(record, 'conversationId', 'conversations');
    }
    if (record.table === 'tasks') {
      requireReference(record, 'conversationId', 'conversations');
      requireReference(record, 'parentTaskId', 'tasks');
      requireReference(record, 'scheduleId', 'schedules');
      requireReference(record, 'goalId', 'goals');
    }
    if (record.table === 'call_sessions') {
      requireReference(record, 'taskId', 'tasks', true);
      requireReference(record, 'toolCallId', 'tool_calls', true);
    }
    if (record.table === 'tool_calls') {
      requireReference(record, 'taskId', 'tasks', true);
      requireReference(record, 'approvalId', 'approvals');
    }
    if (record.table === 'approvals') {
      requireReference(record, 'taskId', 'tasks', true);
      requireReference(record, 'toolCallId', 'tool_calls', true);
      const call = records.find(
        (candidate) => candidate.table === 'tool_calls' && candidate.id === record.data.toolCallId,
      );
      if (call?.data.taskId !== record.data.taskId || call?.data.approvalId !== record.id)
        throw new Error(`Inconsistent approval tool linkage: ${record.id}`);
      requireReference(record, 'createdPolicyId', 'approval_policies');
    }
    if (record.table === 'application_confirmations') {
      requireReference(record, 'conversationId', 'conversations');
      requireReference(record, 'sourceTaskId', 'tasks', true);
      requireReference(record, 'confirmationMessageId', 'messages');
    }
    if (record.table === 'skills') requireReference(record, 'sourceTaskId', 'tasks');
    if (record.table === 'skill_library_revisions')
      requireReference(record, 'agentId', 'agents', true);
    if (record.table === 'memories') {
      requireReference(record, 'subjectContactId', 'contacts');
      requireReference(record, 'sourceTaskId', 'tasks');
      requireReference(record, 'goalId', 'goals');
      requireReference(record, 'supersededById', 'memories');
      const spaceKey = record.data.embeddingSpaceKey;
      if (
        spaceKey !== undefined &&
        spaceKey !== null &&
        (typeof spaceKey !== 'string' || !/^[a-f0-9]{64}$/.test(spaceKey))
      )
        throw new Error(`Invalid memories/${record.id} embedding space identity`);
    }
    if (record.table === 'memory_embedding_refreshes') {
      requireReference(record, 'memoryId', 'memories', true);
      requireParent(record, 'memoryId', 'memories', 'agentId', record.data.agentId);
      if (
        typeof record.data.sourceHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.data.sourceHash) ||
        typeof record.data.targetSpaceKey !== 'string' ||
        !/^[a-f0-9]{64}$/.test(record.data.targetSpaceKey) ||
        !Number.isInteger(record.data.targetDimensions) ||
        Number(record.data.targetDimensions) < 1 ||
        Number(record.data.targetDimensions) > 2048 ||
        ![
          'dispatching',
          'prepared',
          'unknown',
          'retry_authorized',
          'completed',
          'stale',
          'abandoned',
        ].includes(String(record.data.status))
      )
        throw new Error(`Invalid memory_embedding_refreshes/${record.id} receipt`);
      if (record.data.preparedVector !== null && record.data.preparedVector !== undefined) {
        const decoded = deserializeMigrationValue(record.data.preparedVector as SerializedValue);
        if (
          !Array.isArray(decoded) ||
          decoded.length !== record.data.targetDimensions ||
          !decoded.every((value) => typeof value === 'number' && Number.isFinite(value))
        )
          throw new Error(`Invalid memory_embedding_refreshes/${record.id} prepared vector`);
      }
    }
    if (record.table === 'knowledge_graph_entities')
      requireReference(record, 'contactId', 'contacts');
    if (record.table === 'knowledge_graph_entity_aliases')
      requireReference(record, 'entityId', 'knowledge_graph_entities', true);
    if (record.table === 'knowledge_graph_sources') {
      requireReference(record, 'memoryId', 'memories', true);
      requireReference(record, 'subjectContactId', 'contacts');
    }
    if (record.table === 'knowledge_graph_relations') {
      requireReference(record, 'subjectEntityId', 'knowledge_graph_entities', true);
      requireReference(record, 'objectEntityId', 'knowledge_graph_entities', true);
      requireReference(record, 'sourceMemoryId', 'memories', true);
      requireReference(record, 'assertionId', 'knowledge_graph_assertions');
    }
    if (record.table === 'knowledge_graph_assertions') {
      requireReference(record, 'subjectEntityId', 'knowledge_graph_entities', true);
      requireReference(record, 'objectEntityId', 'knowledge_graph_entities', true);
      requireReference(record, 'supersededById', 'knowledge_graph_assertions');
    }
    if (record.table === 'knowledge_graph_assertion_evidence') {
      requireReference(record, 'assertionId', 'knowledge_graph_assertions', true);
      requireReference(record, 'sourceMemoryId', 'memories', true);
    }
    if (record.table === 'occasions') requireReference(record, 'contactId', 'contacts', true);
    if (record.table === 'import_sources') requireReference(record, 'taskId', 'tasks');
    if (record.table === 'model_roles') {
      requireReference(record, 'primaryModel', 'models', true);
      requireReference(record, 'fallbackModel', 'models', true);
    }
    if (record.table === 'model_calls') requireReference(record, 'taskId', 'tasks');
    if (record.table === 'model_call_audit') {
      requireReference(record, 'modelCallId', 'model_calls');
      requireReference(record, 'taskId', 'tasks');
    }
    if (record.table === 'cost_events') {
      requireReference(record, 'taskId', 'tasks');
      requireReference(record, 'toolCallId', 'tool_calls');
      requireReference(record, 'reservationId', 'cost_reservations');
    }
    if (record.table === 'cost_reservations') requireReference(record, 'taskId', 'tasks');
    if (record.table === 'email_ingest')
      requireReference(record, 'conversationId', 'conversations');
    if (record.table === 'email_attachment_custodies') {
      requireReference(record, 'observerWorkId', 'email_observer_work');
      requireReference(record, 'fileId', 'files');
      requireReference(record, 'documentId', 'documents');
      requireReference(record, 'duplicateDocumentId', 'documents');
      requireParent(
        record,
        'observerWorkId',
        'email_observer_work',
        'agentId',
        record.data.agentId,
      );
      requireParent(record, 'fileId', 'files', 'agentId', record.data.agentId);
      requireParent(record, 'documentId', 'documents', 'agentId', record.data.agentId);
      requireParent(record, 'duplicateDocumentId', 'documents', 'agentId', record.data.agentId);
    }
    if (record.table === 'files') {
      requireReference(record, 'emailAttachmentCustodyId', 'email_attachment_custodies');
      requireParent(
        record,
        'emailAttachmentCustodyId',
        'email_attachment_custodies',
        'agentId',
        record.data.agentId,
      );
    }
    if (record.table === 'suggestions') {
      requireReference(record, 'conversationId', 'conversations');
      requireReference(record, 'acceptedTaskId', 'tasks');
    }
    if (record.table === 'watches') requireReference(record, 'conversationId', 'conversations');
    if (record.table === 'watch_fires') requireReference(record, 'watchId', 'watches', true);
    // Fire-effect rows are durable receipts and intentionally outlive deleted
    // watch/fire records while idempotent destination work is being reconciled.
    if (record.table === 'files') requireReference(record, 'taskId', 'tasks');
    if (record.table === 'documents') requireReference(record, 'fileId', 'files', true);
    if (record.table === 'document_chunks')
      requireReference(record, 'documentId', 'documents', true);
    if (record.table === 'response_checks') requireReference(record, 'taskId', 'tasks', true);
    if (record.table === 'recall_metrics') {
      requireReference(record, 'taskId', 'tasks');
      requireReference(record, 'conversationId', 'conversations');
    }
    if (record.table === 'recall_feedback') requireReference(record, 'messageId', 'messages', true);
  }
}
