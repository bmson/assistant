import { pathToFileURL } from 'node:url';
import { agents, createDb, type Db, emailIngest } from '@assistant/db';
import {
  createInstallationStore,
  decodeRecord,
  type InstallationStore,
} from '@assistant/firestore';
import { PENDING_MAIL_ADMISSION_STAGES } from '@assistant/persistence';
import { FieldPath, type QueryDocumentSnapshot } from '@google-cloud/firestore';
import { asc, eq } from 'drizzle-orm';

const MAX_ROWS = 10_000;
const HOUR = 3_600_000;
const VALUE_BUCKETS = ['missing', 'null', 'unrecognized'];
const DIMENSIONS = {
  pipelineStage: [...PENDING_MAIL_ADMISSION_STAGES, 'complete', 'needs_attention'],
  ingestMode: ['direct', 'forwarded'],
  admittedSourceKind: ['message', 'automated_source'],
  scoreStatus: ['pending', 'in_progress', 'prepared', 'unknown'],
} as const;
const FIELDS = [
  'pipelineStage',
  'ingestMode',
  'admittedSourceKind',
  'scoreStatus',
  'createdAt',
  'extractedAt',
] as const;
type CensusInput = Partial<Record<(typeof FIELDS)[number], unknown>>;
type ScanOptions = { owner: string; limit: number; asOf: Date };

function tally(buckets: readonly string[]) {
  return Object.fromEntries([...buckets, ...VALUE_BUCKETS].map((bucket) => [bucket, 0]));
}

function valueBucket(value: unknown): string | undefined {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  return undefined;
}

function ageBucket(value: unknown, asOf: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    return valueBucket(value) ?? 'unrecognized';
  const hours = (asOf.getTime() - value.getTime()) / HOUR;
  if (hours < 0) return 'future';
  if (hours < 6) return 'under6h';
  if (hours < 24) return '6hTo24h';
  if (hours < 168) return '1dTo7d';
  return '7dOrMore';
}

function accumulator(driver: 'postgres' | 'firestore', asOf: Date, limit: number) {
  const dimensions = {
    pipelineStage: tally(DIMENSIONS.pipelineStage),
    ingestMode: tally(DIMENSIONS.ingestMode),
    admittedSourceKind: tally(DIMENSIONS.admittedSourceKind),
    scoreStatus: tally(DIMENSIONS.scoreStatus),
    age: tally(['future', 'under6h', '6hTo24h', '1dTo7d', '7dOrMore']),
    extractedAt: tally(['set']),
  };
  let scannedRows = 0;
  let truncated = false;
  return {
    visit(row: CensusInput): void {
      if (scannedRows >= limit) {
        truncated = true;
        return;
      }
      scannedRows += 1;
      for (const key of Object.keys(DIMENSIONS) as Array<keyof typeof DIMENSIONS>) {
        const value = row[key];
        const known: readonly unknown[] = DIMENSIONS[key];
        const bucket =
          typeof value === 'string' && known.includes(value)
            ? value
            : (valueBucket(value) ?? 'unrecognized');
        dimensions[key][bucket] = (dimensions[key][bucket] ?? 0) + 1;
      }
      const age = ageBucket(row.createdAt, asOf);
      dimensions.age[age] = (dimensions.age[age] ?? 0) + 1;
      const extracted = row.extractedAt;
      const extractionBucket =
        extracted instanceof Date && Number.isFinite(extracted.getTime())
          ? 'set'
          : (valueBucket(extracted) ?? 'unrecognized');
      dimensions.extractedAt[extractionBucket] =
        (dimensions.extractedAt[extractionBucket] ?? 0) + 1;
    },
    result() {
      return {
        driver,
        asOf: asOf.toISOString(),
        scope: 'one owner',
        coverage: {
          complete: !truncated,
          scannedRows,
          limit,
          order: 'document or row id ascending',
        },
        missingFieldsSupported: driver === 'firestore',
        dimensions,
      };
    },
  };
}

function validateScan({ owner, limit, asOf }: ScanOptions): void {
  if (
    !owner.trim() ||
    owner.length > 128 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_ROWS ||
    !Number.isFinite(asOf.getTime())
  )
    throw new Error('Invalid census scope, time, or row limit.');
}

export async function readPostgresMailCensus(db: Db, options: ScanOptions) {
  validateScan(options);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.owner))
    throw new Error('PostgreSQL owner ID must be a UUID.');
  return db.transaction(
    async (tx) => {
      const [owner] = await tx
        .select({ found: agents.id })
        .from(agents)
        .where(eq(agents.id, options.owner));
      if (!owner) throw new Error('The specified census owner was not found.');
      const rows = await tx
        .select({
          pipelineStage: emailIngest.pipelineStage,
          ingestMode: emailIngest.ingestMode,
          admittedSourceKind: emailIngest.admittedSourceKind,
          scoreStatus: emailIngest.scoreStatus,
          createdAt: emailIngest.createdAt,
          extractedAt: emailIngest.extractedAt,
        })
        .from(emailIngest)
        .where(eq(emailIngest.agentId, options.owner))
        .orderBy(asc(emailIngest.id))
        .limit(options.limit + 1);
      const census = accumulator('postgres', options.asOf, options.limit);
      for (const row of rows) census.visit(row);
      return census.result();
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

export async function readFirestoreMailCensus(store: InstallationStore, options: ScanOptions) {
  validateScan(options);
  return store.db.runTransaction(
    async (tx) => {
      const owner = await tx.get(store.doc('agents', options.owner));
      if (!owner.exists || owner.get('id') !== options.owner)
        throw new Error('The specified census owner was not found.');
      const census = accumulator('firestore', options.asOf, options.limit);
      const query = store
        .collection('emailIngest')
        .where('agentId', '==', options.owner)
        .orderBy(FieldPath.documentId())
        .select(...FIELDS);
      let cursor: QueryDocumentSnapshot | undefined;
      let remaining = options.limit + 1;
      while (remaining > 0) {
        const size = Math.min(remaining, 250);
        const page = await tx.get((cursor ? query.startAfter(cursor) : query).limit(size));
        for (const doc of page.docs) census.visit(decodeRecord<CensusInput>(doc.data()));
        if (page.size < size) break;
        remaining -= page.size;
        cursor = page.docs.at(-1);
      }
      return census.result();
    },
    { readOnly: true },
  );
}

const USAGE = `pnpm mail:census --read-only (--local | --operator) --driver (postgres | firestore) [--limit N]
Set MAIL_CENSUS_OWNER_ID to the target owner's ID.
PostgreSQL uses MAIL_CENSUS_DATABASE_URL. Local mode requires a loopback URL.
Firestore uses GCP_PROJECT, ASSISTANT_WORKSPACE_ID, and FIRESTORE_DATABASE_ID.
Local Firestore also requires a demo-* project and loopback FIRESTORE_EMULATOR_HOST.
Operator mode targets the explicitly configured database using existing credentials.`;

export function mailCensusTarget(args: string[], env: NodeJS.ProcessEnv) {
  const readOnly = args.includes('--read-only');
  const local = args.includes('--local');
  const operator = args.includes('--operator');
  const parameters = args.filter((arg) => !['--read-only', '--local', '--operator'].includes(arg));
  const [driverFlag, driver, limitFlag, rawLimit] = parameters;
  if (
    !readOnly ||
    local === operator ||
    driverFlag !== '--driver' ||
    (driver !== 'postgres' && driver !== 'firestore') ||
    (parameters.length !== 2 &&
      (parameters.length !== 4 || limitFlag !== '--limit' || !/^\d+$/.test(rawLimit ?? '')))
  )
    throw new Error(USAGE);
  if (operator && (env.NODE_ENV === 'test' || env.ASSISTANT_TEST_TARGET_TOKEN))
    throw new Error('Tests can only run the local census.');
  const owner = env.MAIL_CENSUS_OWNER_ID?.trim() ?? '';
  const limit = rawLimit ? Number(rawLimit) : MAX_ROWS;
  const asOf = new Date();
  validateScan({ owner, limit, asOf });
  if (driver === 'postgres') {
    const databaseUrl = env.MAIL_CENSUS_DATABASE_URL;
    let url: URL;
    try {
      url = new URL(databaseUrl ?? '');
    } catch {
      throw new Error('Set a valid MAIL_CENSUS_DATABASE_URL explicitly.');
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      !url.pathname.slice(1)
    )
      throw new Error('Set a valid MAIL_CENSUS_DATABASE_URL explicitly.');
    if (local && (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search))
      throw new Error(
        'Local PostgreSQL census requires a loopback URL without connection overrides.',
      );
    return { driver, url: url.href, owner, limit, asOf } as const;
  }
  const projectId = env.GCP_PROJECT?.trim();
  const installationId = env.ASSISTANT_WORKSPACE_ID?.trim();
  const databaseId = env.FIRESTORE_DATABASE_ID?.trim();
  const emulator = env.FIRESTORE_EMULATOR_HOST;
  if (!projectId || !installationId || !databaseId)
    throw new Error(
      'Set GCP_PROJECT, ASSISTANT_WORKSPACE_ID, and FIRESTORE_DATABASE_ID explicitly.',
    );
  if (
    local &&
    (!projectId.startsWith('demo-') ||
      !/^(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(emulator ?? ''))
  )
    throw new Error('Local Firestore census requires a demo-* project and a loopback emulator.');
  if (operator && emulator)
    throw new Error('Operator Firestore census refuses an emulator override.');
  return { driver, projectId, installationId, databaseId, owner, limit, asOf } as const;
}

async function readConfiguredCensus(target: ReturnType<typeof mailCensusTarget>) {
  if (target.driver === 'firestore') {
    const store = createInstallationStore(target);
    try {
      return await readFirestoreMailCensus(store, target);
    } finally {
      await store.db.terminate();
    }
  }
  const db = createDb(target.url, { max: 1 });
  try {
    return await readPostgresMailCensus(db, target);
  } finally {
    await db.$client.end();
  }
}

async function main() {
  if (process.argv.slice(2).join(' ') === '--help') {
    console.log(USAGE);
    return;
  }
  const target = mailCensusTarget(process.argv.slice(2), process.env);
  try {
    const census = await readConfiguredCensus(target);
    console.log(JSON.stringify(census, null, 2));
  } catch {
    throw new Error(
      'Mail census could not read the configured owner and target. No results were emitted.',
    );
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Mail census failed.');
    process.exitCode = 1;
  });
}
