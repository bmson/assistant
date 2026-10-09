import {
  assertSupportedMigrationTables,
  checksumV3,
  compositeMigrationId,
  deterministicMigrationCompare,
  MIGRATION_TABLES,
  type MigrationBundle,
  type MigrationManifest,
  type MigrationRecord,
  type MigrationTable,
  type MigrationTarget,
  serializeMigrationTimestamp,
  serializeMigrationValueV3,
  serializeMigrationVector,
  snakeToCamel,
  validateMigrationReferences,
} from '@assistant/persistence';
import postgres from 'postgres';

export type WorkspaceSnapshotOptions = {
  databaseUrl: string;
  agentId: string;
  target: MigrationTarget;
  tables?: readonly string[];
  embeddingSpace?: { provider: string; model: string; dimensions: number; revision: string };
};

function identifiers(table: MigrationTable) {
  const definition = MIGRATION_TABLES.find((candidate) => candidate.table === table);
  if (!definition) throw new Error(`Unsupported migration table: ${table}`);
  return definition;
}

const TIMESTAMP_PREFIX = '__assistant_timestamp__';

// PostgreSQL column names do not always encode the TypeScript field's acronym
// spelling. Firestore records must use the same keys as the live repositories.
const FIELD_NAME_OVERRIDES: Partial<Record<MigrationTable, Record<string, string>>> = {
  calendar_event_snapshots: { ical_uid: 'iCalUID' },
  models: {
    prompt_cost_per_mtok: 'promptCostPerMTok',
    completion_cost_per_mtok: 'completionCostPerMTok',
  },
};

export function migrationColumnFieldName(table: MigrationTable, column: string): string {
  return FIELD_NAME_OVERRIDES[table]?.[column] ?? snakeToCamel(column);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function projection(table: MigrationTable, columns: Map<MigrationTable, string[]>): string {
  return [
    'x.*',
    ...(columns.get(table) ?? []).map(
      (column) =>
        `x.${quoteIdentifier(column)}::text as ${quoteIdentifier(`${TIMESTAMP_PREFIX}${column}`)}`,
    ),
  ].join(', ');
}

function serializeTypedColumn(
  table: MigrationTable,
  column: string,
  value: unknown,
): ReturnType<typeof serializeMigrationValueV3> {
  if (table === 'gmail_sync_state' && column === 'last_history_id' && typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) throw new Error(`Invalid bigint ${table}.${column}`);
    return serializeMigrationValueV3(BigInt(value));
  }
  if (table === 'files' && column === 'bytes' && typeof value === 'string') {
    if (!/^\d+$/.test(value)) throw new Error(`Invalid byte count ${table}.${column}`);
    const bytes = Number(value);
    if (!Number.isSafeInteger(bytes)) throw new Error(`Unsafe integer ${table}.${column}`);
    return serializeMigrationValueV3(bytes);
  }
  return serializeMigrationValueV3(value);
}

/**
 * Export a workspace using one PostgreSQL REPEATABLE READ, READ ONLY snapshot.
 * The query shapes are intentionally explicit: a future table must be added
 * with its ownership/reference rule instead of accidentally exporting data.
 */
export async function exportWorkspaceSnapshot(
  options: WorkspaceSnapshotOptions,
): Promise<MigrationBundle> {
  const tables = assertSupportedMigrationTables(
    options.tables ?? MIGRATION_TABLES.map(({ table }) => table),
  );
  const client = postgres(options.databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 10,
    onnotice: () => {},
  });
  try {
    return await client.begin(async (connection) => {
      await connection`set transaction isolation level repeatable read, read only`;
      await connection`set local timezone to 'UTC'`;
      const [snapshotRow] = await connection<
        { snapshot: string; exported_at: string }[]
      >`select txid_current_snapshot() as snapshot, to_char(transaction_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as exported_at`;
      if (!snapshotRow?.snapshot)
        throw new Error('PostgreSQL did not return a snapshot identifier');
      const snapshot = snapshotRow.snapshot;
      const [agentCountRow] = await connection<
        { count: string }[]
      >`select count(*)::text as count from agents`;
      const agentCount = agentCountRow?.count;
      const completeRequested = tables.length === MIGRATION_TABLES.length;
      const installationOnly = new Set<MigrationTable>([
        'budgets',
        'canary_runs',
        'contacts',
        'cost_events',
        'cost_reservations',
        'gmail_sync_state',
        'maintenance_cursors',
        'memory_tombstones',
        'model_call_audit',
        'model_calls',
        'model_roles',
        'models',
        'owner_card',
        'rate_limits',
        'rate_table',
        'tool_cache',
        'voice_profile',
        'writing_samples',
      ]);
      if (
        Number(agentCount) !== 1 &&
        (completeRequested || tables.some((table) => installationOnly.has(table)))
      )
        throw new Error('Installation migration requires exactly one PostgreSQL agent');
      if (Number(agentCount) === 1) {
        const [owner] = await connection<{ id: string }[]>`select id from agents limit 1`;
        if (owner?.id !== options.agentId)
          throw new Error('Requested source agent is not the installation owner');
      }
      const sourceTables = await connection<
        { table_name: string }[]
      >`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
      const timestampRows = await connection<
        { table_name: MigrationTable; column_name: string }[]
      >`select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type in ('timestamp with time zone', 'timestamp without time zone') order by table_name, ordinal_position`;
      const timestampColumns = new Map<MigrationTable, string[]>();
      for (const row of timestampRows) {
        const list = timestampColumns.get(row.table_name) ?? [];
        list.push(row.column_name);
        timestampColumns.set(row.table_name, list);
      }
      const records: MigrationRecord[] = [];
      for (const table of tables) {
        const definition = identifiers(table);
        const select = projection(table, timestampColumns);
        let rows: Record<string, unknown>[];
        if (Number(agentCount) === 1) {
          // A complete customer transfer is installation-scoped. The single-agent
          // assertion above is the ownership boundary and keeps indirect/global rows.
          rows = await connection.unsafe(
            `select ${select} from ${quoteIdentifier(table)} x order by x.${quoteIdentifier(definition.id)}`,
          );
        } else if (table === 'agents') {
          rows = await connection.unsafe(
            `select ${select} from agents x where x.id = $1 order by x.id`,
            [options.agentId],
          );
        } else if (table === 'channel_bindings' || table === 'messages') {
          rows = await connection.unsafe(
            `select ${select} from ${quoteIdentifier(table)} x join conversations c on c.id = x.conversation_id where c.agent_id = $1 order by x.${quoteIdentifier(definition.id)}`,
            [options.agentId],
          );
        } else if (
          table === 'tool_calls' ||
          table === 'approvals' ||
          table === 'response_checks' ||
          table === 'execution_job_callback_receipts'
        ) {
          rows = await connection.unsafe(
            `select ${select} from ${quoteIdentifier(table)} x join tasks t on t.id = x.task_id where t.agent_id = $1 order by x.${quoteIdentifier(definition.id)}`,
            [options.agentId],
          );
        } else if (table === 'generated_card_revisions') {
          rows = await connection.unsafe(
            `select ${select} from generated_card_revisions x join generated_cards c on c.id = x.card_id where c.agent_id = $1 order by x.id`,
            [options.agentId],
          );
        } else if (table === 'situation_previews') {
          rows = await connection.unsafe(
            `select ${select} from situation_previews x join situation_packs p on p.id = x.pack_id where p.agent_id = $1 order by x.id`,
            [options.agentId],
          );
        } else if (table === 'knowledge_graph_sources') {
          rows = await connection.unsafe(
            `select ${select} from knowledge_graph_sources x join memories m on m.id = x.memory_id where m.agent_id = $1 order by x.memory_id`,
            [options.agentId],
          );
        } else {
          rows = await connection.unsafe(
            `select ${select} from ${quoteIdentifier(table)} x where x.agent_id = $1 order by x.${quoteIdentifier(definition.id)}`,
            [options.agentId],
          );
        }
        for (const row of rows) {
          const rawId = row[definition.id];
          if (rawId === undefined || rawId === null)
            throw new Error(`Missing ${table}.${definition.id}`);
          const data = Object.fromEntries(
            Object.entries(row)
              .filter(([key]) => !key.startsWith(TIMESTAMP_PREFIX))
              .sort(([a], [b]) => deterministicMigrationCompare(a, b))
              .map(([key, value]) => {
                const timestamp = row[`${TIMESTAMP_PREFIX}${key}`];
                if (typeof timestamp === 'string')
                  return [
                    migrationColumnFieldName(table, key),
                    serializeMigrationTimestamp(timestamp),
                  ];
                if (
                  (key === 'embedding' || key === 'prepared_vector') &&
                  Array.isArray(value) &&
                  value.every((item) => typeof item === 'number')
                )
                  return [migrationColumnFieldName(table, key), serializeMigrationVector(value)];
                if (
                  (key === 'embedding' || key === 'prepared_vector') &&
                  typeof value === 'string'
                ) {
                  try {
                    const vector = JSON.parse(value) as unknown;
                    if (Array.isArray(vector) && vector.every((item) => typeof item === 'number'))
                      return [
                        migrationColumnFieldName(table, key),
                        serializeMigrationVector(vector),
                      ];
                  } catch {
                    // Keep malformed vectors visible to validation rather than silently changing them.
                  }
                }
                return [
                  migrationColumnFieldName(table, key),
                  serializeTypedColumn(table, key, value),
                ];
              }),
          );
          const singletonByAgent = table === 'owner_card' || table === 'ambient_snapshots';
          const migratedId =
            (singletonByAgent ? options.agentId : null) ??
            compositeMigrationId(table, data) ??
            String(rawId);
          if (table === 'owner_card') {
            data.agentId = options.agentId;
            data.postgresqlId = serializeMigrationValueV3(rawId);
            delete data.id;
          }
          if (table === 'ambient_snapshots') {
            data.postgresqlId = serializeMigrationValueV3(rawId);
            delete data.id;
          }
          // `writing_samples` is installation-wide in PostgreSQL. Installation
          // exports have already proved there is exactly one source owner, so
          // persist that provenance in Firestore for owner-scoped reads/erasure.
          if (table === 'writing_samples') data.agentId = options.agentId;
          records.push({
            table,
            collection: definition.collection,
            id: migratedId,
            data,
            checksum: checksumV3(data),
          });
        }
      }
      records.sort((a, b) =>
        deterministicMigrationCompare(`${a.table}:${a.id}`, `${b.table}:${b.id}`),
      );
      const vectorRecords = records.filter((record) => {
        const value = record.data.embedding ?? record.data.preparedVector;
        const tag =
          value && typeof value === 'object' && !Array.isArray(value)
            ? (value as { $assistantMigration?: unknown }).$assistantMigration
            : undefined;
        return Array.isArray(tag) && tag[0] === 'vector';
      });
      if (vectorRecords.length && !options.embeddingSpace)
        throw new Error(
          'Snapshot contains vectors; explicit embedding provider, model, dimensions, and revision are required',
        );
      if (options.embeddingSpace) {
        for (const record of vectorRecords) {
          const value = (record.data.embedding ?? record.data.preparedVector) as {
            $assistantMigration: ['vector', number[]];
          };
          if (value.$assistantMigration[1].length !== options.embeddingSpace.dimensions)
            throw new Error(
              `Embedding provenance dimension mismatch: ${record.table}/${record.id}`,
            );
        }
      }
      validateMigrationReferences(records, options.agentId);
      const tableSummary = Object.fromEntries(
        tables.map((table) => {
          const definition = identifiers(table);
          const selected = records.filter((record) => record.table === table);
          return [
            table,
            {
              collection: definition.collection,
              count: selected.length,
              checksum: checksumV3(selected),
            },
          ];
        }),
      ) as MigrationManifest['tables'];
      const manifest: MigrationManifest = {
        format: 'assistant-workspace-migration',
        formatVersion: 3,
        mode: 'export',
        source: {
          kind: 'postgresql',
          agentId: options.agentId,
          scope: 'installation',
          snapshot,
          exportedAt: snapshotRow.exported_at,
          ...(options.embeddingSpace ? { embeddingSpace: options.embeddingSpace } : {}),
        },
        target: options.target,
        tables: tableSummary,
        coverage: {
          complete:
            sourceTables.length === MIGRATION_TABLES.length &&
            tables.length === MIGRATION_TABLES.length &&
            sourceTables.every((row) => tables.includes(row.table_name as MigrationTable)),
          supportedTables: tables,
          omittedTables: sourceTables
            .map((row) => row.table_name)
            .filter((table) => !tables.includes(table as MigrationTable)),
        },
        recordCount: records.length,
        bundleChecksum: checksumV3(records),
        unsupportedTables: [],
      };
      return { manifest, records };
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}
