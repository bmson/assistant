import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAgent } from '@assistant/core';
import {
  commitments,
  conversations,
  createDb,
  generatedCardRevisions,
  generatedCards,
  messages,
  situationPacks,
} from '@assistant/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertAllocatedTestTargetMarker, testTargetMarkerPath } from '../test-target.js';

const repositoryRoot = process.cwd();
const databaseUrl = process.env.TEST_DATABASE_URL;
const token = process.env.ASSISTANT_TEST_TARGET_TOKEN;
if (!databaseUrl || !token) throw new Error('Run through the allocated pnpm test wrapper');
const target = assertAllocatedTestTargetMarker({
  databaseUrl,
  testDatabaseUrl: databaseUrl,
  token,
  kind: process.env.ASSISTANT_TEST_TARGET_KIND === 'restore' ? 'restore' : 'standard',
});
const db = createDb(databaseUrl, { max: 5 });
const writerEntry = fileURLToPath(new URL('./situation-packs.ts', import.meta.url));
const cleanupEntry = fileURLToPath(new URL('./cleanup-fixtures.ts', import.meta.url));
const fixtureKind = 'situation-packs';
const childTimeoutMs = 15_000;
const groupQuiescenceMs = 4_000;
const testTimeoutMs = 75_000;
const egressPreloader = pathToFileURL(
  fileURLToPath(new URL('../deny-test-egress.mjs', import.meta.url)),
).href;

type ChildResult = { code: number | null; signal: NodeJS.Signals | null };
type PausedBackend = {
  pid: number;
  backendStart: string;
  databaseName: string;
  applicationName: string;
};
type OwnedChild = {
  child: ReturnType<typeof spawn>;
  pid: number | undefined;
  done: Promise<ChildResult | { error: Error }>;
  output: () => string;
};

function startOwnedNode(entry: string, args: string[], env: NodeJS.ProcessEnv): OwnedChild {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', entry, ...args], {
    cwd: repositoryRoot,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-32_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  const done = new Promise<ChildResult | { error: Error }>((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, pid: child.pid, done, output: () => output };
}

async function boundedResult(
  owned: OwnedChild,
  timeoutMs: number,
  description: string,
): Promise<ChildResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      owned.done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${description} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    if ('error' in result) throw result.error;
    return result;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    throw new Error(`${text}; child output: ${redactOutput(owned.output())}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redactOutput(output: string, allocatedUrl = databaseUrl): string {
  const secrets = new Set<string>([allocatedUrl ?? '']);
  try {
    const parsed = new URL(allocatedUrl ?? '');
    if (parsed.password) {
      secrets.add(parsed.password);
      try {
        secrets.add(decodeURIComponent(parsed.password));
      } catch {
        // Keep the original encoded form; malformed escapes are still redacted.
      }
    }
  } catch {
    // The allocated URL is separately redacted when it is available.
  }
  let safe = output;
  for (const secret of secrets) {
    if (secret) safe = safe.replaceAll(secret, '[redacted-database-secret]');
  }
  return safe.slice(-4_000);
}

function signalOwnedGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid || pid <= 1) throw new Error('Refusing to signal an unowned child process group');
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
}

async function requireGroupGone(pid: number | undefined): Promise<void> {
  if (!pid || pid <= 1) throw new Error('Missing owned child process-group ID');
  const deadline = Date.now() + groupQuiescenceMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
      lastError = new Error('owned process group still exists');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Owned process group did not become quiescent: ${String(lastError)}`);
}

async function stopOwnedChild(owned: OwnedChild, description: string): Promise<void> {
  signalOwnedGroup(owned.pid, 'SIGKILL');
  await boundedResult(owned, 5_000, description);
  await requireGroupGone(owned.pid);
}

async function discoverManifest(
  directory: string,
  options: { allowIncompleteWrite?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const files = names.filter((name) => name.endsWith('.manifest.json'));
  if (files.length === 0) return null;
  if (files.length !== 1) throw new Error(`Expected one child manifest; found ${files.length}`);
  try {
    return JSON.parse(await readFile(path.join(directory, files[0] as string), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (options.allowIncompleteWrite && error instanceof SyntaxError) return null;
    if (options.allowIncompleteWrite && (error as NodeJS.ErrnoException).code === 'ENOENT')
      return null;
    throw error;
  }
}

function requiredUuid(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new Error(`Interrupted fixture manifest has an invalid ${label}`);
  return value;
}

function validatedManifestIds(
  manifest: Record<string, unknown>,
  expectedAgentId: string,
): {
  runId: string;
  conversationId: string;
  commitmentId: string;
  cardId: string;
  revisionId: string;
  situationPackId: string;
} {
  const runId = requiredUuid(manifest.runId, 'run ID');
  if (
    manifest.schemaVersion !== 1 ||
    manifest.fixtureKind !== fixtureKind ||
    manifest.status !== 'planned' ||
    manifest.targetDatabaseName !== target.databaseName ||
    manifest.targetToken !== token ||
    manifest.agentId !== expectedAgentId
  )
    throw new Error('Interrupted fixture manifest identity or pre-write state is invalid');
  const ids = manifest.ids;
  if (!ids || typeof ids !== 'object' || Array.isArray(ids))
    throw new Error('Interrupted fixture manifest has no ID inventory');
  const values = ids as Record<string, unknown>;
  if (values.conversationCreated !== true)
    throw new Error('Interrupted fixture manifest does not own its conversation');
  const oneUuid = (field: string): string => {
    const rows = values[field];
    if (!Array.isArray(rows) || rows.length !== 1)
      throw new Error(`Interrupted fixture manifest has an invalid ${field} inventory`);
    return requiredUuid(rows[0], field);
  };
  const resolved = {
    runId,
    conversationId: requiredUuid(values.conversationId, 'conversation ID'),
    commitmentId: oneUuid('commitmentIds'),
    cardId: oneUuid('cardIds'),
    revisionId: oneUuid('cardRevisionIds'),
    situationPackId: oneUuid('situationPackIds'),
  };
  if (new Set(Object.values(resolved).filter((value) => value !== runId)).size !== 5)
    throw new Error('Interrupted fixture manifest has duplicate table IDs');
  const creationKeys = values.situationCreationKeys;
  if (
    !Array.isArray(creationKeys) ||
    creationKeys.length !== 1 ||
    typeof creationKeys[0] !== 'string' ||
    !creationKeys[0].startsWith(`visual-qa:${runId}:situation-packs:pack:`)
  )
    throw new Error('Interrupted fixture manifest has an invalid situation creation key');
  const provenance = manifest.provenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance))
    throw new Error('Interrupted fixture manifest has invalid provenance');
  const provenanceFields = provenance as Record<string, unknown>;
  const cardFingerprint = provenanceFields.cardFingerprint;
  if (
    provenanceFields.marker !== `visual-qa:${runId}:situation-packs` ||
    typeof cardFingerprint !== 'string' ||
    !cardFingerprint.startsWith(`visual-qa:${runId}:situation-packs:card:`)
  )
    throw new Error('Interrupted fixture manifest has invalid provenance');
  return resolved;
}

async function waitForPausedWriter(input: {
  child: OwnedChild;
  directory: string;
  applicationName: string;
}): Promise<{ manifest: Record<string, unknown>; backend: PausedBackend }> {
  const deadline = Date.now() + childTimeoutMs;
  while (Date.now() < deadline) {
    const manifest = await discoverManifest(input.directory, { allowIncompleteWrite: true });
    if (manifest) {
      const rows = await db.execute<{
        pid: number;
        backend_start: string;
        datname: string;
        application_name: string;
        wait_event_type: string | null;
        wait_event: string | null;
        query: string;
      }>(sql`
        SELECT pid, backend_start::text AS backend_start, datname, application_name,
          wait_event_type, wait_event, query
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = ${input.applicationName}
          AND state = 'active'
          AND wait_event = 'PgSleep'
          AND query ILIKE '%insert into%commitments%'
        LIMIT 1`);
      const activity = rows[0];
      if (activity?.wait_event_type === 'Timeout')
        return {
          manifest,
          backend: {
            pid: activity.pid,
            backendStart: activity.backend_start,
            databaseName: activity.datname,
            applicationName: activity.application_name,
          },
        };
    }
    const state = await Promise.race([
      input.child.done,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    if (state !== 'pending') {
      if ('error' in state) throw state.error;
      throw new Error(
        `Writer exited before the injected first-write pause (${state.signal ?? state.code}): ${redactOutput(input.child.output())}`,
      );
    }
  }
  throw new Error(
    `Writer never reached the owned commitments insert pause: ${redactOutput(input.child.output())}`,
  );
}

async function recoverInterruptedWriterBackend(
  applicationName: string,
  expected?: PausedBackend,
): Promise<{ cancelledByHarness: boolean }> {
  let cancelledByHarness = false;
  const deadline = Date.now() + groupQuiescenceMs;
  while (Date.now() < deadline) {
    const rows = await db.execute<{
      pid: number;
      backend_start: string;
      datname: string;
      application_name: string;
      state: string | null;
      wait_event: string | null;
      query: string;
    }>(sql`
      SELECT pid, backend_start::text AS backend_start, datname, application_name,
        state, wait_event, query
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${applicationName}`);
    if (rows.length === 0) return { cancelledByHarness };
    if (rows.length !== 1)
      throw new Error('Expected one uniquely named interrupted writer backend');
    const backend = rows[0];
    if (!backend) throw new Error('Interrupted writer backend disappeared during inspection');
    if (
      backend.datname !== target.databaseName ||
      backend.application_name !== applicationName ||
      (expected &&
        (backend.pid !== expected.pid ||
          backend.backend_start !== expected.backendStart ||
          backend.datname !== expected.databaseName ||
          backend.application_name !== expected.applicationName))
    )
      throw new Error(
        'Interrupted writer backend identity changed; refusing database cancellation',
      );

    const isOwnedPause =
      backend.state === 'active' &&
      backend.wait_event === 'PgSleep' &&
      /insert into[\s\S]*commitments/i.test(backend.query);
    if (isOwnedPause && !cancelledByHarness) {
      const cancellation = await db.execute<{ cancelled: boolean }>(sql`
        SELECT pg_cancel_backend(pid) AS cancelled
        FROM pg_stat_activity
        WHERE pid = ${backend.pid}
          AND backend_start = ${backend.backend_start}::timestamptz
          AND datname = current_database()
          AND application_name = ${applicationName}
          AND state = 'active'
          AND wait_event = 'PgSleep'
          AND query ILIKE '%insert into%commitments%'`);
      if (cancellation[0]?.cancelled) cancelledByHarness = true;
    } else if (!isOwnedPause && !cancelledByHarness) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (cancelledByHarness) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Interrupted writer backend did not disconnect within ${groupQuiescenceMs}ms after exact-identity recovery`,
  );
}

async function waitForApplicationToDisconnect(applicationName: string): Promise<void> {
  const deadline = Date.now() + groupQuiescenceMs;
  while (Date.now() < deadline) {
    const rows = await db.execute<{ pid: number }>(sql`
      SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${applicationName}`);
    if (rows.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Interrupted writer database session did not close: ${applicationName}`);
}

async function ensurePrivateAllocatorMarker(privateTemp: string): Promise<string> {
  const sourcePath = testTargetMarkerPath(token);
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || (sourceStat.mode & 0o077) !== 0)
    throw new Error(
      'Refusing child fixture launch: allocator marker is not a private regular file.',
    );
  const markerBytes = await readFile(sourcePath);
  const marker = JSON.parse(markerBytes.toString('utf8')) as {
    databaseUrl?: unknown;
    token?: unknown;
  };
  if (marker.databaseUrl !== databaseUrl || marker.token !== token)
    throw new Error('Refusing child fixture launch: allocator marker identity changed.');

  const privatePath = path.join(privateTemp, path.basename(sourcePath));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(privatePath, 'wx', 0o600);
    await handle.writeFile(markerBytes);
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existingStat = await lstat(privatePath);
    if (
      !existingStat.isFile() ||
      existingStat.isSymbolicLink() ||
      (existingStat.mode & 0o077) !== 0 ||
      !(await readFile(privatePath)).equals(markerBytes)
    )
      throw new Error(
        'Refusing child fixture launch: private allocator marker is not owned or exact.',
      );
  } finally {
    await handle?.close();
  }
  const privateStat = await lstat(privatePath);
  if (!privateStat.isFile() || privateStat.isSymbolicLink() || (privateStat.mode & 0o077) !== 0)
    throw new Error(
      'Refusing child fixture launch: private allocator marker permissions are unsafe.',
    );
  return privatePath;
}

async function childEnvironment(input: {
  artifactDirectory: string;
  applicationName: string;
  privateRoot: string;
}): Promise<NodeJS.ProcessEnv> {
  const home = path.join(input.privateRoot, 'home');
  const temp = path.join(input.privateRoot, 'tmp');
  await mkdir(home, { mode: 0o700, recursive: true });
  await mkdir(temp, { mode: 0o700, recursive: true });
  await chmod(home, 0o700);
  await chmod(temp, 0o700);
  for (const directory of [input.privateRoot, home, temp]) {
    const directoryStat = await stat(directory);
    if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0)
      throw new Error('Could not create private child-process temporary directories');
  }
  await ensurePrivateAllocatorMarker(temp);
  const inheritedNodeOptions = process.env.NODE_OPTIONS ?? '';
  const nodeOptions = inheritedNodeOptions.includes(egressPreloader)
    ? inheritedNodeOptions
    : [inheritedNodeOptions, `--import=${egressPreloader}`].filter(Boolean).join(' ');
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: temp,
    NODE_ENV: 'test',
    NODE_OPTIONS: nodeOptions,
    DATABASE_URL: databaseUrl,
    TEST_DATABASE_URL: databaseUrl,
    ASSISTANT_TEST_TARGET_TOKEN: token,
    ASSISTANT_TEST_TARGET_KIND: target.kind,
    ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS: '1',
    ASSISTANT_VISUAL_QA_ARTIFACT_DIR: input.artifactDirectory,
    PGAPPNAME: input.applicationName,
  };
}

describe('visual QA fixture recovery after OS process interruption', () => {
  it('redacts allocated database URL and encoded or decoded password from child diagnostics', () => {
    const original = new URL(databaseUrl);
    const intendedPassword = 'ops16 safe redaction% fixture';
    const encodedPassword = encodeURIComponent(intendedPassword);
    const syntheticUrl = new URL(
      `${original.protocol}//${original.username}:${encodedPassword}@${original.host}${original.pathname}${original.search}${original.hash}`,
    );
    const decodedPassword = decodeURIComponent(syntheticUrl.password);
    const allocatedUrl = syntheticUrl.toString();
    const sanitized = redactOutput(
      `${allocatedUrl} ${encodedPassword} ${decodedPassword}`,
      allocatedUrl,
    );
    expect(sanitized).not.toContain(allocatedUrl);
    expect(sanitized).not.toContain(encodedPassword);
    expect(sanitized).not.toContain(decodedPassword);
    expect(redactOutput(databaseUrl)).not.toContain(databaseUrl);
  });

  let agentId = '';
  let unrelatedConversation: typeof conversations.$inferSelect | undefined;
  let unrelatedMessage: typeof messages.$inferSelect | undefined;
  let primaryBefore: (typeof conversations.$inferSelect)[] = [];
  let primaryFixtureConversationId: string | undefined;
  let primaryFixtureMessageId: string | undefined;
  let primaryMessagesBefore: (typeof messages.$inferSelect)[] = [];
  let dbUp = false;

  beforeAll(async () => {
    const agent = await getAgent(db);
    agentId = agent.id;
    dbUp = true;
    primaryBefore = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.isPrimary, true)));
    if (primaryBefore.length === 0) {
      const [primaryFixture] = await db
        .insert(conversations)
        .values({
          id: randomUUID(),
          agentId,
          channel: 'chat',
          title: 'Ordinary primary conversation protected by interruption cleanup',
          trust: 'owner',
          isPrimary: true,
          metadata: { control: 'ordinary-primary-owner-row' },
        })
        .onConflictDoNothing()
        .returning();
      if (primaryFixture) primaryFixtureConversationId = primaryFixture.id;
      primaryBefore = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.agentId, agentId), eq(conversations.isPrimary, true)));
    }
    if (primaryBefore.length === 0)
      throw new Error('Could not establish a nonempty primary-conversation control');
    primaryMessagesBefore = await db
      .select()
      .from(messages)
      .where(
        inArray(
          messages.conversationId,
          primaryBefore.map((row) => row.id),
        ),
      );
    if (primaryMessagesBefore.length === 0) {
      const primary = primaryBefore[0];
      if (!primary) throw new Error('Primary-conversation control is missing');
      const [primaryMessage] = await db
        .insert(messages)
        .values({
          id: randomUUID(),
          conversationId: primary.id,
          role: 'user',
          origin: 'owner',
          text: 'Ordinary primary message protected by interruption cleanup.',
          parts: [],
        })
        .returning();
      if (!primaryMessage) throw new Error('Could not seed protected primary-conversation message');
      primaryFixtureMessageId = primaryMessage.id;
      primaryMessagesBefore = [primaryMessage];
    }
    const conversationId = randomUUID();
    const [conversation] = await db
      .insert(conversations)
      .values({
        id: conversationId,
        agentId,
        channel: 'chat',
        title: 'Ordinary owner conversation retained by interruption cleanup',
        trust: 'owner',
        metadata: { control: 'ordinary-owner-row' },
      })
      .returning();
    if (!conversation) throw new Error('Could not seed unrelated owner conversation');
    unrelatedConversation = conversation;
    const [message] = await db
      .insert(messages)
      .values({
        id: randomUUID(),
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'Ordinary owner message that must survive fixture recovery.',
        parts: [],
      })
      .returning();
    if (!message) throw new Error('Could not seed unrelated owner message');
    unrelatedMessage = message;

    // Snapshot controls only after fixture setup has finished. Insert triggers
    // legitimately advance messageSequence on both ordinary conversations.
    primaryBefore = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.agentId, agentId), eq(conversations.isPrimary, true)));
    if (primaryBefore.length === 0 || primaryBefore.some((row) => !row.id))
      throw new Error('Could not snapshot exact primary-conversation control rows');
    primaryMessagesBefore = await db
      .select()
      .from(messages)
      .where(
        inArray(
          messages.conversationId,
          primaryBefore.map((row) => row.id),
        ),
      );
    if (primaryMessagesBefore.length === 0 || primaryMessagesBefore.some((row) => !row.id))
      throw new Error('Could not snapshot exact primary-conversation messages');

    const [unrelatedConversationSnapshot] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!unrelatedConversationSnapshot?.id)
      throw new Error('Could not snapshot unrelated owner conversation');
    unrelatedConversation = unrelatedConversationSnapshot;
    const [unrelatedMessageSnapshot] = await db
      .select()
      .from(messages)
      .where(eq(messages.id, message.id));
    if (!unrelatedMessageSnapshot?.id)
      throw new Error('Could not snapshot unrelated owner message');
    unrelatedMessage = unrelatedMessageSnapshot;
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      if (dbUp && unrelatedMessage)
        await db.delete(messages).where(eq(messages.id, unrelatedMessage.id));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (dbUp && unrelatedConversation)
        await db.delete(conversations).where(eq(conversations.id, unrelatedConversation.id));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (dbUp && primaryFixtureMessageId)
        await db.delete(messages).where(eq(messages.id, primaryFixtureMessageId));
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (dbUp && primaryFixtureConversationId)
        await db.delete(conversations).where(eq(conversations.id, primaryFixtureConversationId));
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      try {
        await db.$client.end({ timeout: 5 });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'OPS-16 fixture cleanup failed');
  });

  it(
    'keeps a planned cleanup manifest and removes only an interrupted writer’s exact fixture IDs',
    async () => {
      const artifactDirectory = await mkdtemp(path.join(tmpdir(), 'assistant-ops16-interruption-'));
      const privateRoot = await mkdtemp(path.join(tmpdir(), 'assistant-ops16-private-'));
      const privateAllocatorMarker = path.join(
        privateRoot,
        'tmp',
        path.basename(testTargetMarkerPath(token)),
      );
      const applicationName = `ops16_vqa_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const sqlIdentifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const triggerName = `pause_vqa_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
      const functionName = `pause_vqa_${randomUUID().replaceAll('-', '').slice(0, 18)}`;
      const functionSql = `
      CREATE FUNCTION public.${sqlIdentifier(functionName)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep(35);
        RETURN NEW;
      END;
      $$`;
      const triggerSql = `
      CREATE TRIGGER ${sqlIdentifier(triggerName)}
      AFTER INSERT ON public.commitments
      FOR EACH ROW
      WHEN (current_setting('application_name', true) = '${applicationName}'
        AND NEW.details LIKE 'visual-qa:%:situation-packs:commitment')
      EXECUTE FUNCTION public.${sqlIdentifier(functionName)}()`;
      let triggerInstalled = false;
      let functionInstalled = false;
      let writer: OwnedChild | undefined;
      let recoveryChild: OwnedChild | undefined;
      let recoveryApplicationName: string | undefined;
      let recoveredRunId: string | undefined;
      let pausedWriterBackend: PausedBackend | undefined;
      let writerBackendCancellationAssisted = false;
      let passed = false;
      let failure: unknown;

      try {
        await db.execute(sql.raw(functionSql));
        functionInstalled = true;
        await db.execute(sql.raw(triggerSql));
        triggerInstalled = true;
        writer = startOwnedNode(
          writerEntry,
          [],
          await childEnvironment({ artifactDirectory, applicationName, privateRoot }),
        );
        const pausedWriter = await waitForPausedWriter({
          child: writer,
          directory: artifactDirectory,
          applicationName,
        });
        pausedWriterBackend = pausedWriter.backend;
        const fixtureIds = validatedManifestIds(pausedWriter.manifest, agentId);
        recoveredRunId = fixtureIds.runId;
        const journalText = await readFile(
          path.join(artifactDirectory, `${recoveredRunId}.jsonl`),
          'utf8',
        );
        if (!journalText.includes('"event":"fixture_run_planned"'))
          throw new Error('Interrupted fixture manifest has no completed planned journal event');

        const fixtureConversationId = fixtureIds.conversationId;
        const [partialConversation] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, fixtureConversationId));
        expect(partialConversation?.metadata).toMatchObject({
          visualQaRunId: recoveredRunId,
          targetDatabaseName: target.databaseName,
        });
        expect(partialConversation?.agentId).toBe(agentId);

        signalOwnedGroup(writer.pid, 'SIGKILL');
        const writerExit = await boundedResult(writer, 5_000, 'SIGKILLed fixture writer shutdown');
        expect(writerExit.signal).toBe('SIGKILL');
        await requireGroupGone(writer.pid);
        const backendRecovery = await recoverInterruptedWriterBackend(
          applicationName,
          pausedWriterBackend,
        );
        writerBackendCancellationAssisted = backendRecovery.cancelledByHarness;
        expect(typeof writerBackendCancellationAssisted).toBe('boolean');
        writer = undefined;

        const stillPlanned = await discoverManifest(artifactDirectory);
        expect(stillPlanned?.status).toBe('planned');

        recoveryChild = startOwnedNode(
          cleanupEntry,
          [recoveredRunId],
          await childEnvironment({
            artifactDirectory,
            applicationName: `${applicationName}_cleanup`,
            privateRoot,
          }),
        );
        recoveryApplicationName = `${applicationName}_cleanup`;
        const recoveryExit = await boundedResult(
          recoveryChild,
          10_000,
          'fresh exact-ID cleanup process',
        );
        expect(recoveryExit).toEqual({ code: 0, signal: null });
        await requireGroupGone(recoveryChild.pid);
        expect(redactOutput(recoveryChild.output())).toContain(`"runId":"${recoveredRunId}"`);
        expect(redactOutput(recoveryChild.output())).toContain('"cleaned":1');
        recoveryChild = undefined;
        recoveryApplicationName = undefined;

        const cleaned = JSON.parse(
          await readFile(path.join(artifactDirectory, `${recoveredRunId}.manifest.json`), 'utf8'),
        ) as Record<string, unknown>;
        expect(cleaned.status).toBe('cleaned');
        expect(
          await db.select().from(conversations).where(eq(conversations.id, fixtureConversationId)),
        ).toEqual([]);
        expect(
          await db.select().from(commitments).where(eq(commitments.id, fixtureIds.commitmentId)),
        ).toEqual([]);
        expect(
          await db.select().from(generatedCards).where(eq(generatedCards.id, fixtureIds.cardId)),
        ).toEqual([]);
        expect(
          await db
            .select()
            .from(generatedCardRevisions)
            .where(eq(generatedCardRevisions.id, fixtureIds.revisionId)),
        ).toEqual([]);
        expect(
          await db
            .select()
            .from(situationPacks)
            .where(eq(situationPacks.id, fixtureIds.situationPackId)),
        ).toEqual([]);
        expect(
          await db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, fixtureConversationId)),
        ).toEqual([]);

        const [ordinaryConversationAfter] = await db
          .select()
          .from(conversations)
          .where(eq(conversations.id, unrelatedConversation?.id ?? ''));
        const [ordinaryMessageAfter] = await db
          .select()
          .from(messages)
          .where(eq(messages.id, unrelatedMessage?.id ?? ''));
        expect(ordinaryConversationAfter).toEqual(unrelatedConversation);
        expect(ordinaryMessageAfter).toEqual(unrelatedMessage);
        const primaryAfter = await db
          .select()
          .from(conversations)
          .where(and(eq(conversations.agentId, agentId), eq(conversations.isPrimary, true)));
        expect(primaryAfter).toEqual(primaryBefore);
        const primaryMessagesAfter = await db
          .select()
          .from(messages)
          .where(
            inArray(
              messages.conversationId,
              primaryAfter.map((row) => row.id),
            ),
          );
        expect(primaryMessagesAfter).toEqual(primaryMessagesBefore);
        console.info(
          JSON.stringify({
            fixtureRecovery: 'OPS-16',
            interruption: 'SIGKILL',
            writerProcessGroupGone: true,
            backendCancellationAssisted: writerBackendCancellationAssisted,
            freshExactIdCleanup: true,
            primaryAndUnrelatedRowsPreserved: true,
          }),
        );
        passed = true;
      } catch (error) {
        failure = error;
      }

      const cleanupErrors: unknown[] = [];
      if (writer) {
        try {
          await stopOwnedChild(writer, 'fixture writer failure cleanup');
          const backendRecovery = await recoverInterruptedWriterBackend(
            applicationName,
            pausedWriterBackend,
          );
          writerBackendCancellationAssisted = backendRecovery.cancelledByHarness;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (recoveryChild) {
        try {
          await stopOwnedChild(recoveryChild, 'cleanup child failure cleanup');
          if (recoveryApplicationName)
            await waitForApplicationToDisconnect(recoveryApplicationName);
        } catch (error) {
          cleanupErrors.push(error);
        }
        recoveryChild = undefined;
        recoveryApplicationName = undefined;
      }
      if (triggerInstalled) {
        try {
          await db.execute(
            sql.raw(`DROP TRIGGER IF EXISTS ${sqlIdentifier(triggerName)} ON public.commitments`),
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (functionInstalled) {
        try {
          await db.execute(
            sql.raw(`DROP FUNCTION IF EXISTS public.${sqlIdentifier(functionName)}()`),
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (!recoveredRunId) {
        try {
          const manifest = await discoverManifest(artifactDirectory);
          const discoveredId = manifest?.runId;
          if (typeof discoveredId === 'string' && /^[0-9a-f-]{36}$/i.test(discoveredId))
            recoveredRunId = discoveredId;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (recoveredRunId && !passed && cleanupErrors.length === 0) {
        try {
          const manifest = await discoverManifest(artifactDirectory);
          if (manifest?.status !== 'cleaned') {
            recoveryApplicationName = `${applicationName}_retry`;
            recoveryChild = startOwnedNode(
              cleanupEntry,
              [recoveredRunId],
              await childEnvironment({
                artifactDirectory,
                applicationName: recoveryApplicationName,
                privateRoot,
              }),
            );
            const result = await boundedResult(
              recoveryChild,
              10_000,
              'failure-path exact-ID cleanup',
            );
            if (result.code !== 0) throw new Error(`failure-path cleanup exited ${result.code}`);
            await requireGroupGone(recoveryChild.pid);
            recoveryChild = undefined;
            recoveryApplicationName = undefined;
          }
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (recoveryChild) {
        try {
          await stopOwnedChild(recoveryChild, 'failure-path cleanup child shutdown');
          if (recoveryApplicationName)
            await waitForApplicationToDisconnect(recoveryApplicationName);
        } catch (error) {
          cleanupErrors.push(error);
        }
        recoveryChild = undefined;
        recoveryApplicationName = undefined;
      }
      if (passed && cleanupErrors.length === 0) {
        try {
          await rm(artifactDirectory, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        await unlink(privateAllocatorMarker).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await rm(privateRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (failure && cleanupErrors.length)
        throw new AggregateError(
          [failure, ...cleanupErrors],
          `OPS-16 interruption failed and cleanup also reported errors; evidence: ${artifactDirectory}`,
        );
      if (failure) throw failure;
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          `OPS-16 interruption cleanup failed; evidence: ${artifactDirectory}`,
        );
      if (!passed)
        throw new Error(`OPS-16 interruption did not complete; evidence: ${artifactDirectory}`);
    },
    testTimeoutMs,
  );
});
