import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq } from 'drizzle-orm';
import { createDb } from './client.js';
import { createPostgresProfileMemoryManagementRepository } from './profile-memory-management-repository.js';
import { contacts, memories } from './schema.js';

const exec = promisify(execFile);
let migrationPass = 0;
const expectedRoles = ['agent', 'web', 'browser', 'code', 'processor', 'migration'] as const;
type Role = (typeof expectedRoles)[number];
type RuntimeRole = 'agent' | 'web';
const runtimeContainers: OwnedContainer[] = [];
let runtimeRegistrySourceSha: string | undefined;

interface OwnedContainer {
  role: RuntimeRole | 'migration';
  name: string;
  imageId: string;
  cid?: string;
  lifecycle?:
    | 'registered'
    | 'created'
    | 'started'
    | 'start-attempted'
    | 'exited'
    | 'closed'
    | 'unknown';
  closure?: ContainerClosure;
}

interface ContainerClosure {
  role: OwnedContainer['role'];
  name: string;
  cid: string | null;
  imageId: string;
  removed: boolean;
  absenceVerified: true;
}

interface QualificationImages {
  sourceSha: string;
  contractSha256: string;
  imageIdBasis: string;
  images: Record<Role, string>;
}

async function readImages(path: string): Promise<QualificationImages> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<QualificationImages>;
  if (!parsed.sourceSha || !/^[a-f0-9]{40}$/.test(parsed.sourceSha))
    throw new Error('Image qualification receipt has no pinned source SHA.');
  if (!parsed.contractSha256 || !/^[a-f0-9]{64}$/.test(parsed.contractSha256))
    throw new Error('Image qualification receipt has no embedded contract SHA-256.');
  if (parsed.imageIdBasis !== 'Docker local image configuration ID, not registry manifest digest')
    throw new Error('Image qualification receipt does not identify its local image ID basis.');
  if (
    process.env.ASSISTANT_MEMORY_WITNESS_EXPECTED_SOURCE_SHA &&
    parsed.sourceSha !== process.env.ASSISTANT_MEMORY_WITNESS_EXPECTED_SOURCE_SHA
  )
    throw new Error('Image qualification receipt source SHA differs from the checked-out source.');
  if (
    !parsed.images ||
    Object.keys(parsed.images).sort().join(',') !== [...expectedRoles].sort().join(',')
  )
    throw new Error('Image qualification receipt must contain all five roles and migration image.');
  const ids = Object.values(parsed.images);
  if (ids.some((id) => typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)))
    throw new Error('Image qualification receipt contains an invalid immutable image ID.');
  if (new Set(ids).size !== ids.length) throw new Error('Role image IDs must be distinct.');
  runtimeRegistrySourceSha = parsed.sourceSha;
  return parsed as QualificationImages;
}

async function allocatePort(): Promise<number> {
  const server = await import('node:net').then(({ createServer }) => createServer());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve a loopback port.');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function assertContainerAbsent(record: OwnedContainer): Promise<void> {
  const nameRows = await exec(
    'docker',
    [
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `name=^/${record.name}$`,
      '--format',
      '{{.ID}} {{.Names}}',
    ],
    { timeout: 5_000, maxBuffer: 32 * 1024 },
  );
  const idRows = record.cid
    ? await exec(
        'docker',
        [
          'container',
          'ls',
          '--all',
          '--no-trunc',
          '--filter',
          `id=${record.cid}`,
          '--format',
          '{{.ID}} {{.Names}}',
        ],
        { timeout: 5_000, maxBuffer: 32 * 1024 },
      )
    : { stdout: '' };
  if (nameRows.stdout.trim() || idRows.stdout.trim())
    throw new Error(`Owned container closure is not absent: ${record.name}.`);
}

async function inspectOwnedContainer(record: OwnedContainer): Promise<boolean> {
  try {
    const { stdout } = await exec(
      'docker',
      [
        'container',
        'inspect',
        '--format',
        '{{.Id}}\t{{.Image}}\t{{.Name}}\t{{index .Config.Labels "com.assistant.memory-witness.owner"}}',
        record.name,
      ],
      { timeout: 5_000, maxBuffer: 32 * 1024 },
    );
    const [cid, imageId, name, ownerLabel] = stdout.trim().split('\t');
    if (
      !cid ||
      imageId !== record.imageId ||
      name !== `/${record.name}` ||
      ownerLabel !== record.name
    )
      throw new Error(
        `Owned container identity does not match expected name/image: ${record.name}.`,
      );
    if (record.cid && cid !== record.cid)
      throw new Error(`Owned container ID changed for ${record.name}.`);
    record.cid = cid;
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('identity does not match')) throw error;
    if (error instanceof Error && error.message.includes('ID changed')) throw error;
    await assertContainerAbsent(record);
    return false;
  }
}

async function removeOwnedContainer(record: OwnedContainer): Promise<ContainerClosure> {
  const existed = await inspectOwnedContainer(record);
  if (existed) {
    await exec('docker', ['container', 'rm', '--force', record.name], {
      timeout: 15_000,
      maxBuffer: 32 * 1024,
    });
  }
  await assertContainerAbsent(record);
  return {
    role: record.role,
    name: record.name,
    cid: record.cid ?? null,
    imageId: record.imageId,
    removed: existed,
    absenceVerified: true,
  };
}

async function startRole(
  record: OwnedContainer,
  databaseUrl: string,
  port: number,
): Promise<{ role: RuntimeRole; name: string; imageId: string; cid?: string; port: number }> {
  const role = record.role as RuntimeRole;
  const imageId = record.imageId;
  const name = record.name;
  const denyEgress = join(process.cwd(), 'scripts/deny-test-egress.mjs');
  const args = [
    'run',
    '--detach',
    '--name',
    name,
    '--label',
    `com.assistant.memory-witness.owner=${name}`,
    '--network',
    'host',
    '--read-only',
    '--log-opt',
    'max-size=64k',
    '--log-opt',
    'max-file=1',
    '--memory',
    '768m',
    '--cpus',
    '1',
    '--pids-limit',
    '128',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=64m',
    '--mount',
    `type=bind,src=${denyEgress},dst=/tmp/deny-test-egress.mjs,readonly`,
    '--env',
    'NODE_OPTIONS=--import=/tmp/deny-test-egress.mjs',
    '--env',
    'ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS=1',
    '--env',
    `DATABASE_URL=${databaseUrl}`,
    '--env',
    'PERSISTENCE_DRIVER=postgres',
    '--env',
    'QUEUE_DRIVER=inert',
    '--env',
    'OTEL_EXPORTER=none',
    '--env',
    'ASSISTANT_MODULES=reminders',
    '--env',
    'ASSISTANT_WORKSPACE_ID=memory-witness-qualification',
  ];
  if (role === 'agent') args.push('--env', `AGENT_PORT=${port}`);
  else args.push('--env', `PORT=${port}`, '--env', 'HOSTNAME=127.0.0.1');
  args.push(imageId);
  record.lifecycle = 'registered';
  await persistOwnedContainerRegistration(record);
  const { stdout } = await exec('docker', args, { timeout: 20_000, maxBuffer: 32 * 1024 });
  record.cid = stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(record.cid))
    throw new Error(`Docker did not start ${role} container.`);
  await persistOwnedContainerRegistration(record);
  await inspectOwnedContainer(record);
  record.lifecycle = 'started';
  await persistOwnedContainerRegistration(record);
  return { role, name, imageId, cid: record.cid, port };
}

async function waitReady(role: 'agent' | 'web', port: number): Promise<void> {
  const url =
    role === 'agent' ? `http://127.0.0.1:${port}/ready` : `http://127.0.0.1:${port}/api/ready`;
  const deadline = Date.now() + 45_000;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      const body = await response.text();
      last = `${response.status} ${body.slice(0, 512)}`;
      if (response.ok) {
        const parsed = JSON.parse(body) as { ready?: unknown; database?: unknown };
        const database = role === 'agent' ? 'postgres' : 'ready';
        if (parsed.ready === true && parsed.database === database) return;
        throw new Error(`${role} readiness returned unexpected content: ${last}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('unexpected content')) throw error;
      last = error instanceof Error ? error.message.slice(0, 256) : 'request failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${role} did not become ready against PostgreSQL: ${last}`);
}

async function logs(record: OwnedContainer): Promise<string> {
  try {
    const exists = await inspectOwnedContainer(record);
    if (!exists) return 'container already absent';
    const { stdout, stderr } = await exec(
      'docker',
      ['logs', '--tail', '80', record.cid as string],
      {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      },
    );
    return `${stdout}\n${stderr}`.slice(-32 * 1024);
  } catch (error) {
    return String(error).slice(0, 2_000);
  }
}

async function persistReceiptFile(name: string, content: string | object): Promise<void> {
  const directory = process.env.ASSISTANT_MEMORY_WITNESS_PROOF_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const body = typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`;
  await writeFile(join(directory, name), body.slice(0, 128 * 1024), { mode: 0o600 });
}

async function persistOwnedContainerRegistration(record: OwnedContainer): Promise<void> {
  if (!runtimeRegistrySourceSha)
    throw new Error('Owned-container source SHA must be loaded before container registration.');
  const directory = process.env.ASSISTANT_MEMORY_WITNESS_PROOF_DIR;
  if (!directory)
    throw new Error('Owned-container qualification requires a private proof directory.');
  if (!runtimeContainers.some((entry) => entry.name === record.name))
    runtimeContainers.push(record);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'owned-runtime-containers.json');
  const temporary = `${path}.${process.pid}.tmp`;
  const content = `${JSON.stringify(
    {
      sourceSha: runtimeRegistrySourceSha,
      containers: runtimeContainers.map((entry) => ({
        role: entry.role,
        name: entry.name,
        imageId: entry.imageId,
        ownerLabel: entry.name,
        cid: entry.cid ?? null,
        lifecycle: entry.lifecycle ?? 'registered',
        closure: entry.closure ?? null,
      })),
    },
    null,
    2,
  )}\n`;
  await writeFile(temporary, content, { mode: 0o600 });
  const file = await open(temporary, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

/**
 * Optional CI-only qualification of the exact locally built role images. The
 * service probes prove the shipped agent and web entrypoints become ready
 * against the migrated database. The host Vitest process separately reads the
 * legacy row and exercises the ordinary repository create/confirm path; this
 * does not claim those writes were issued through a service HTTP endpoint.
 */
export async function qualifyMemoryWitnessRoleImages(input: {
  imageReceiptPath: string;
  databaseUrl: string;
  ownerId: string;
  legacyMemoryId: string;
  legacyContent: string;
}): Promise<void> {
  const receipt = await readImages(input.imageReceiptPath);
  const active: Array<OwnedContainer & { role: RuntimeRole; port: number }> = [];
  const db = createDb(input.databaseUrl, {
    max: 1,
    idleTimeoutSeconds: 5,
    connectTimeoutSeconds: 10,
    statementTimeoutMs: 15_000,
  });
  let subjectId: string | undefined;
  let memoryId: string | undefined;
  let primaryError: unknown;
  let cleanupFailure: AggregateError | undefined;
  const readyRoles: RuntimeRole[] = [];
  const diagnosticErrors: string[] = [];
  let legacyWitnessObservation = 'not observed';
  let genericCreateWitnessObservation = 'not observed';
  let genericConfirmWitnessObservation = 'not observed';
  try {
    const [legacy] = await db.select().from(memories).where(eq(memories.id, input.legacyMemoryId));
    if (legacy)
      legacyWitnessObservation = legacy.memoryWriteWitness === null ? 'SQL NULL' : 'non-NULL';
    if (!legacy || legacy.content !== input.legacyContent || legacy.memoryWriteWitness !== null)
      throw new Error('Default Drizzle read did not preserve the legacy NULL witness row.');

    const agentPort = await allocatePort();
    const webPort = await allocatePort();
    const agentRecord: OwnedContainer & { role: RuntimeRole; port: number } = {
      role: 'agent',
      name: `memory-witness-agent-${randomUUID()}`,
      imageId: receipt.images.agent,
      port: agentPort,
    };
    active.push(agentRecord);
    Object.assign(agentRecord, await startRole(agentRecord, input.databaseUrl, agentPort));
    const webRecord: OwnedContainer & { role: RuntimeRole; port: number } = {
      role: 'web',
      name: `memory-witness-web-${randomUUID()}`,
      imageId: receipt.images.web,
      port: webPort,
    };
    active.push(webRecord);
    Object.assign(webRecord, await startRole(webRecord, input.databaseUrl, webPort));
    const readiness = await Promise.allSettled([
      waitReady('agent', agentPort),
      waitReady('web', webPort),
    ]);
    if (readiness[0]?.status === 'fulfilled') readyRoles.push('agent');
    if (readiness[1]?.status === 'fulfilled') readyRoles.push('web');
    const readinessFailure = readiness.find((result) => result.status === 'rejected');
    if (readinessFailure?.status === 'rejected') throw readinessFailure.reason;

    const [subject] = await db
      .insert(contacts)
      .values({ name: 'Synthetic witness qualification contact' })
      .returning({ id: contacts.id });
    if (!subject) throw new Error('Could not create the synthetic memory subject contact.');
    subjectId = subject.id;
    const content = `Generic writer qualification ${randomUUID()}`;
    const contentHash = createHash('sha256').update(content).digest('hex');
    const repository = createPostgresProfileMemoryManagementRepository(db, input.ownerId);
    const created = await repository.create({
      content,
      contentHash,
      embedding: Array.from({ length: 1536 }, () => 0),
      importance: 3,
      pinned: false,
      subjectContactId: subject.id,
    });
    if (created.status !== 'updated' || !created.memory)
      throw new Error(`Generic profile-memory create failed: ${created.status}.`);
    memoryId = created.memory.id;
    const [written] = await db.select().from(memories).where(eq(memories.id, created.memory.id));
    if (written)
      genericCreateWitnessObservation =
        written.memoryWriteWitness === null ? 'SQL NULL' : 'non-NULL';
    if (!written || written.memoryWriteWitness !== null)
      throw new Error('Generic create produced a non-NULL memory write witness.');
    const confirmed = await repository.confirm(created.memory.id);
    if (confirmed.status !== 'updated')
      throw new Error(`Generic profile-memory confirm failed: ${confirmed.status}.`);
    const [updated] = await db.select().from(memories).where(eq(memories.id, created.memory.id));
    if (updated)
      genericConfirmWitnessObservation =
        updated.memoryWriteWitness === null ? 'SQL NULL' : 'non-NULL';
    if (!updated || updated.memoryWriteWitness !== null)
      throw new Error('Generic update changed a NULL memory write witness.');
    await db.delete(memories).where(eq(memories.id, created.memory.id));
    memoryId = undefined;
    await db.delete(contacts).where(eq(contacts.id, subject.id));
    subjectId = undefined;
  } catch (error) {
    primaryError = error;
    for (const entry of active) {
      try {
        await persistReceiptFile(`${entry.role}-runtime.log`, await logs(entry));
      } catch (receiptError) {
        diagnosticErrors.push(
          `${entry.role} diagnostic receipt: ${String(receiptError).slice(0, 500)}`,
        );
      }
    }
  } finally {
    const cleanupErrors: string[] = [...diagnosticErrors];
    try {
      if (memoryId) await db.delete(memories).where(eq(memories.id, memoryId));
      if (subjectId) await db.delete(contacts).where(eq(contacts.id, subjectId));
    } catch (error) {
      cleanupErrors.push(`synthetic writer rows: ${String(error).slice(0, 500)}`);
    }
    const containerClosures: ContainerClosure[] = [];
    for (const container of active.reverse()) {
      try {
        await persistReceiptFile(`${container.role}-runtime.log`, await logs(container));
      } catch (error) {
        cleanupErrors.push(`${container.role} log receipt: ${String(error).slice(0, 500)}`);
      }
      try {
        const closure = await removeOwnedContainer(container);
        container.closure = closure;
        container.lifecycle = 'closed';
        containerClosures.push(closure);
        await persistOwnedContainerRegistration(container);
      } catch (error) {
        container.lifecycle = 'unknown';
        cleanupErrors.push(`${container.name}: ${String(error).slice(0, 500)}`);
        try {
          await persistOwnedContainerRegistration(container);
        } catch (receiptError) {
          cleanupErrors.push(
            `${container.name} registry update: ${String(receiptError).slice(0, 500)}`,
          );
        }
      }
    }
    try {
      await db.$client.end({ timeout: 5 });
    } catch (error) {
      cleanupErrors.push(`database client close: ${String(error).slice(0, 500)}`);
    }
    try {
      await persistReceiptFile('runtime-role-qualification.json', {
        sourceSha: receipt.sourceSha,
        contractSha256: receipt.contractSha256,
        imageIdBasis: 'local Docker image configuration ID; not a registry manifest digest',
        imageIds: { agent: receipt.images.agent, web: receipt.images.web },
        runtimeImageProbe: {
          agent: { endpoint: '/ready', database: 'postgres', passed: readyRoles.includes('agent') },
          web: { endpoint: '/api/ready', database: 'ready', passed: readyRoles.includes('web') },
        },
        hostDatabaseProbe: {
          process: 'Vitest process using @assistant/db Drizzle default select and repository',
          legacyWitness: legacyWitnessObservation,
          genericCreateWitness: genericCreateWitnessObservation,
          genericConfirmWitness: genericConfirmWitnessObservation,
          scope: 'not a writer request through either runtime image',
        },
        externalCredentials: 'absent',
        network: 'loopback PostgreSQL and HTTP probes only; Node egress preloader enabled',
        cleanup: {
          containers: containerClosures,
          complete: cleanupErrors.length === 0,
          databaseClientClosed: cleanupErrors.every(
            (error) => !error.startsWith('database client'),
          ),
        },
        completed: !primaryError && cleanupErrors.length === 0,
      });
    } catch (error) {
      cleanupErrors.push(`runtime qualification receipt: ${String(error).slice(0, 500)}`);
    }
    if (cleanupErrors.length)
      cleanupFailure = new AggregateError(
        cleanupErrors.map((error) => new Error(error)),
        'Role image qualification container cleanup failed.',
      );
  }
  if (primaryError && cleanupFailure)
    throw new AggregateError(
      [primaryError, cleanupFailure],
      'Role image qualification failed and cleanup was incomplete.',
    );
  if (primaryError) throw primaryError;
  if (cleanupFailure) throw cleanupFailure;
}

/** Run the pinned migration image with an explicit migration-only CMD override. */
export async function runMemoryWitnessMigrationImage(
  imageReceiptPath: string,
  databaseUrl: string,
): Promise<void> {
  const receipt = await readImages(imageReceiptPath);
  const url = new URL(databaseUrl);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname.replace(/^\[|\]$/g, '')))
    throw new Error('Migration image qualification is limited to the local PostgreSQL fixture.');
  migrationPass += 1;
  const record: OwnedContainer = {
    role: 'migration',
    name: `memory-witness-migration-${randomUUID()}`,
    imageId: receipt.images.migration,
  };
  let primaryError: unknown;
  let output = '';
  let closure: ContainerClosure | undefined;
  let cleanupError: unknown;
  let observedState: string | null = null;
  let observedExitCode: number | null = null;
  try {
    record.lifecycle = 'registered';
    await persistOwnedContainerRegistration(record);
    const { stdout } = await exec(
      'docker',
      [
        'container',
        'create',
        '--name',
        record.name,
        '--label',
        `com.assistant.memory-witness.owner=${record.name}`,
        '--network',
        'host',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=64m',
        '--log-driver',
        'none',
        '--env',
        `DATABASE_URL=${databaseUrl}`,
        '--mount',
        `type=bind,src=${join(process.cwd(), 'scripts/deny-test-egress.mjs')},dst=/tmp/deny-test-egress.mjs,readonly`,
        '--env',
        'NODE_OPTIONS=--import=/tmp/deny-test-egress.mjs',
        '--env',
        'ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS=1',
        record.imageId,
        'pnpm',
        '--filter',
        '@assistant/db',
        'migrate',
      ],
      { timeout: 10_000, maxBuffer: 32 * 1024 },
    );
    record.cid = stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(record.cid))
      throw new Error('Docker did not return a full migration container ID.');
    record.lifecycle = 'created';
    await persistOwnedContainerRegistration(record);
    await inspectOwnedContainer(record);
    record.lifecycle = 'start-attempted';
    await persistOwnedContainerRegistration(record);
    const result = await exec('docker', ['container', 'start', '--attach', record.name], {
      timeout: 45_000,
      maxBuffer: 512 * 1024,
    });
    output = `${result.stdout}\n${result.stderr}`.slice(-128 * 1024);
    const { stdout: stateOutput } = await exec(
      'docker',
      [
        'container',
        'inspect',
        '--format',
        '{{.Id}}\t{{.Image}}\t{{.Name}}\t{{index .Config.Labels "com.assistant.memory-witness.owner"}}\t{{.State.Status}}\t{{.State.ExitCode}}',
        record.cid,
      ],
      { timeout: 5_000, maxBuffer: 32 * 1024 },
    );
    const [cid, imageId, name, ownerLabel, state, exitCode] = stateOutput.trim().split('\t');
    if (
      cid !== record.cid ||
      imageId !== record.imageId ||
      name !== `/${record.name}` ||
      ownerLabel !== record.name
    )
      throw new Error('Migration container identity changed before exit verification.');
    observedState = state ?? null;
    observedExitCode = exitCode && /^\d+$/.test(exitCode) ? Number(exitCode) : null;
    if (observedState !== 'exited' || observedExitCode !== 0)
      throw new Error(
        `Migration image did not exit successfully (state=${observedState}, code=${observedExitCode}).`,
      );
    record.lifecycle = 'exited';
    await persistOwnedContainerRegistration(record);
  } catch (error) {
    const child = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
    output = `${String(child.stdout ?? '')}\n${String(child.stderr ?? '')}`.slice(-128 * 1024);
    primaryError = new Error(
      `Migration image pass ${migrationPass} failed: ${child.message}\n${output.slice(-8_000)}`,
    );
  } finally {
    try {
      closure = await removeOwnedContainer(record);
      record.closure = closure;
      record.lifecycle = 'closed';
      await persistOwnedContainerRegistration(record);
    } catch (error) {
      cleanupError = error;
      record.lifecycle = 'unknown';
      try {
        await persistOwnedContainerRegistration(record);
      } catch (receiptError) {
        cleanupError = new AggregateError(
          [error, receiptError],
          'Migration container cleanup and registry update failed.',
        );
      }
    }
    try {
      await persistReceiptFile(`migration-image-pass-${migrationPass}.log`, output);
      await persistReceiptFile(`migration-image-pass-${migrationPass}.json`, {
        sourceSha: receipt.sourceSha,
        contractSha256: receipt.contractSha256,
        imageIdBasis: 'local Docker image configuration ID; not a registry manifest digest',
        imageId: receipt.images.migration,
        command: ['pnpm', '--filter', '@assistant/db', 'migrate'],
        destination: url.pathname,
        observedContainerState: observedState,
        observedContainerExitCode: observedExitCode,
        container: closure ?? {
          role: record.role,
          name: record.name,
          cid: record.cid ?? null,
          imageId: record.imageId,
          removed: false,
          absenceVerified: false,
        },
        completed: !primaryError && !cleanupError,
      });
    } catch (error) {
      cleanupError = cleanupError
        ? new AggregateError(
            [cleanupError, error],
            'Migration receipt and container cleanup failed.',
          )
        : error;
    }
  }
  if (primaryError && cleanupError)
    throw new AggregateError(
      [primaryError, cleanupError],
      'Migration failed and container cleanup was incomplete.',
    );
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
}
