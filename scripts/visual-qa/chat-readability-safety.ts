import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

export interface ReservationReceipt {
  status: string;
  estimatedUsd: string | number;
  actualUsd: string | number | null;
}

export interface SpendSnapshot {
  reservedUsd: number;
  unknown: boolean;
  unresolvedStatuses: string[];
}

export interface ReadabilityRunManifest {
  schemaVersion: 1;
  runId: string;
  run: 'baseline' | 'reframed';
  targetDatabaseName: string;
  targetToken: string;
  agentId: string;
  taskId: string;
  conversationId: string | null;
  modelId: string;
  framing: string;
  systemPromptSha256: string;
  capUsd: number;
  corpusSha256: string;
  createdAt: string;
  status: 'running' | 'complete' | 'interrupted' | 'cleaned';
}

export function parseReadabilitySpendCap(value: string | undefined): number {
  if (!value || !/^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/.test(value)) {
    throw new Error('generation requires --max-usd=<amount> with at most 4 decimal places');
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10) {
    throw new Error('readability spend cap must be greater than $0 and at most $10');
  }
  return amount;
}

function usd(value: string | number | null): number {
  if (value === null) return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw new Error('invalid cost reservation amount');
  return amount;
}

function usdMicros(value: string | number): number {
  return Math.ceil(usd(value) * 1_000_000 - 1e-7);
}

/** Unknown or still-open attempts remain fully reserved and stop further generation. */
export function summarizeReadabilitySpend(receipts: ReservationReceipt[]): SpendSnapshot {
  const unresolvedStatuses: string[] = [];
  let reservedMicros = 0;
  for (const receipt of receipts) {
    if (receipt.status === 'released') continue;
    if (receipt.status === 'reconciled') {
      if (receipt.actualUsd === null) {
        reservedMicros += usdMicros(receipt.estimatedUsd);
        unresolvedStatuses.push('reconciled_missing_actual');
        continue;
      }
      reservedMicros += usdMicros(receipt.actualUsd);
      continue;
    }
    reservedMicros += usdMicros(receipt.estimatedUsd);
    unresolvedStatuses.push(receipt.status);
  }
  return {
    reservedUsd: reservedMicros / 1_000_000,
    unknown: unresolvedStatuses.length > 0,
    unresolvedStatuses,
  };
}

export function assertReadabilityCallFits(capUsd: number, snapshot: SpendSnapshot): number {
  if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > 10) {
    throw new Error('invalid readability cap');
  }
  if (snapshot.unknown) {
    throw new Error(`stopping: unresolved model usage (${snapshot.unresolvedStatuses.join(', ')})`);
  }
  const capMicros = Math.floor(capUsd * 1_000_000 + 1e-7);
  const reservedMicros = Math.ceil(snapshot.reservedUsd * 1_000_000 - 1e-7);
  const remainingMicros = capMicros - reservedMicros;
  if (remainingMicros <= 0) throw new Error('stopping: readability spend cap is exhausted');
  return remainingMicros / 1_000_000;
}

export async function runCappedReadabilityAttempt<T>(input: {
  capUsd: number;
  readSpend: () => Promise<SpendSnapshot>;
  invoke: (maxEstimatedCostUsd: number) => Promise<T>;
  afterAttempt: (result: T, spend: SpendSnapshot) => Promise<void>;
}): Promise<T> {
  const remaining = assertReadabilityCallFits(input.capUsd, await input.readSpend());
  const result = await input.invoke(remaining);
  const spend = await input.readSpend();
  await input.afterAttempt(result, spend);
  if (spend.unknown) {
    throw new Error('stopping: model usage is unresolved after the provider attempt');
  }
  return result;
}

export function newReadabilityRunId(): string {
  return randomUUID();
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function writeImmutableJson(filePath: string, value: unknown): Promise<void> {
  await privateDirectory(path.dirname(filePath));
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function appendPrivateJsonLine(filePath: string, value: unknown): Promise<void> {
  await privateDirectory(path.dirname(filePath));
  try {
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
      throw new Error('refusing unsafe readability evidence file');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function replacePrivateJson(filePath: string, value: unknown): Promise<void> {
  await privateDirectory(path.dirname(filePath));
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
}

export async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

export async function readPrivateJson<T>(filePath: string): Promise<T> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('refusing unreadable or non-private readability evidence file');
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as T;
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}
