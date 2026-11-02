import { constants } from 'node:fs';
import { lstat, open, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

export const BASIC5_CI_CHROME_EXECUTABLE = '/opt/google/chrome/chrome';
export const BASIC5_CI_PROCESS_RECORD_LIMIT = 64;
export const BASIC5_CI_PROCESS_FILE_BYTE_LIMIT = 64 * 1024;

export const BASIC5_CI_PROCESS_PROOF_FAILURES = [
  'process_census_unavailable',
  'process_stat_unavailable',
  'process_stat_permission_denied',
  'process_stat_malformed',
  'owned_process_identity_ineligible',
  'process_executable_unavailable',
  'process_executable_permission_denied',
  'process_identity_changed',
] as const;

export type Basic5CiProcessProofFailure = (typeof BASIC5_CI_PROCESS_PROOF_FAILURES)[number];

export class Basic5CiProcessProofError extends Error {
  constructor(readonly code: Basic5CiProcessProofFailure) {
    super(`BASIC5 CI process proof failed: ${code}`);
    this.name = 'Basic5CiProcessProofError';
  }
}

export type Basic5CiProcessRole = 'fixture-worker' | 'web' | 'browser' | 'embedding';

export interface Basic5CiProcessIdentity {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  startTimeTicks: string;
  exe: string;
}

export interface Basic5CiProcessRecord extends Basic5CiProcessIdentity {
  version: 1;
  role: Basic5CiProcessRole;
  port?: number;
}

export interface Basic5LinuxProcessSnapshot {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  startTimeTicks: string;
}

export interface Basic5CiProcessRegistry {
  register(role: Basic5CiProcessRole, pid: number, port?: number): Promise<Basic5CiProcessRecord>;
  records(): Promise<Basic5CiProcessRecord[]>;
}

const roles = new Set<Basic5CiProcessRole>(['fixture-worker', 'web', 'browser', 'embedding']);
const completeRoles = ['fixture-worker', 'web', 'browser', 'embedding'] as const;

function assertLinux(): void {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function')
    throw new Error('BASIC5 CI process proof requires Linux /proc and a numeric user identity.');
}

export function parseBasic5LinuxProcessStat(
  expectedPid: number,
  contents: string,
): Basic5LinuxProcessSnapshot {
  const close = contents.lastIndexOf(')');
  const open = contents.indexOf(' (');
  if (open < 1 || close <= open || !/^\d+$/.test(contents.slice(0, open)))
    throw new Basic5CiProcessProofError('process_stat_malformed');
  const pid = Number(contents.slice(0, open));
  const fields = contents
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  const sid = Number(fields[3]);
  const startTimeTicks = fields[19];
  if (
    pid !== expectedPid ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(ppid) ||
    ppid < 0 ||
    !Number.isSafeInteger(pgid) ||
    pgid < 0 ||
    !Number.isSafeInteger(sid) ||
    sid < 0 ||
    !startTimeTicks ||
    !/^\d+$/.test(startTimeTicks)
  )
    throw new Basic5CiProcessProofError('process_stat_malformed');
  return { pid, ppid, pgid, sid, startTimeTicks };
}

function sameProcess(left: Basic5LinuxProcessSnapshot, right: Basic5LinuxProcessSnapshot): boolean {
  return (
    left.pid === right.pid &&
    left.ppid === right.ppid &&
    left.pgid === right.pgid &&
    left.sid === right.sid &&
    left.startTimeTicks === right.startTimeTicks
  );
}

function parseRecord(value: unknown): Basic5CiProcessRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('BASIC5 CI process registry record is malformed.');
  const record = value as Record<string, unknown>;
  const required = ['version', 'role', 'pid', 'startTimeTicks', 'ppid', 'pgid', 'sid', 'exe'];
  const keys = Object.keys(record);
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    keys.some((key) => !required.includes(key) && key !== 'port') ||
    record.version !== 1 ||
    typeof record.role !== 'string' ||
    !roles.has(record.role as Basic5CiProcessRole) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    !Number.isSafeInteger(record.ppid) ||
    (record.ppid as number) < 0 ||
    !Number.isSafeInteger(record.pgid) ||
    (record.pgid as number) <= 0 ||
    !Number.isSafeInteger(record.sid) ||
    (record.sid as number) <= 0 ||
    typeof record.startTimeTicks !== 'string' ||
    !/^\d+$/.test(record.startTimeTicks) ||
    typeof record.exe !== 'string' ||
    !path.isAbsolute(record.exe) ||
    Buffer.byteLength(record.exe) > 4_096 ||
    (Object.hasOwn(record, 'port') &&
      (!Number.isSafeInteger(record.port) ||
        (record.port as number) < 1 ||
        (record.port as number) > 65_535))
  )
    throw new Error('BASIC5 CI process registry record failed strict validation.');
  return record as unknown as Basic5CiProcessRecord;
}

export function parseBasic5CiProcessRegistryText(raw: string): Basic5CiProcessRecord[] {
  if (Buffer.byteLength(raw) > BASIC5_CI_PROCESS_FILE_BYTE_LIMIT)
    throw new Error('BASIC5 CI process registry exceeds its byte limit.');
  if (raw.length === 0) return [];
  if (!raw.endsWith('\n'))
    throw new Error('BASIC5 CI process registry has a partial final record.');
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length > BASIC5_CI_PROCESS_RECORD_LIMIT)
    throw new Error('BASIC5 CI process registry exceeds its record limit.');
  const records = lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error('BASIC5 CI process registry contains invalid JSON.');
    }
    return parseRecord(value);
  });
  const roleSeen = new Set<string>();
  const identityByPid = new Map<number, Basic5CiProcessRecord>();
  for (const record of records) {
    const roleKey = `${record.role}:${record.pid}`;
    if (
      roleSeen.has(roleKey) ||
      records.some((other) => other.role === record.role && other !== record)
    )
      throw new Error('BASIC5 CI process registry repeats a logical role.');
    roleSeen.add(roleKey);
    const previous = identityByPid.get(record.pid);
    if (previous && (!sameProcess(previous, record) || previous.exe !== record.exe))
      throw new Error('BASIC5 CI process registry reuses a PID with conflicting identity.');
    identityByPid.set(record.pid, record);
  }
  return records;
}

function assertCompleteRecords(records: readonly Basic5CiProcessRecord[]): void {
  if (
    records.length !== completeRoles.length ||
    completeRoles.some((role) => !records.some((record) => record.role === role))
  )
    throw new Error('BASIC5 CI process registry does not contain the four required process roles.');
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory))
    throw new Error('BASIC5 CI process registry path must be absolute.');
  let info: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    info = await lstat(directory);
    canonical = await realpath(directory);
  } catch {
    throw new Error('BASIC5 CI process registry parent directory is unavailable.');
  }
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o777) !== 0o700 ||
    canonical !== directory
  )
    throw new Error(
      'BASIC5 CI process registry parent must be a private owned non-symlink directory.',
    );
}

async function assertPrivateRegistryFile(filePath: string, expectedUid: number): Promise<void> {
  await assertPrivateDirectory(path.dirname(filePath));
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(filePath);
  } catch {
    throw new Error('BASIC5 CI process registry file is unavailable.');
  }
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.uid !== expectedUid ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > BASIC5_CI_PROCESS_FILE_BYTE_LIMIT
  )
    throw new Error('BASIC5 CI process registry must be an owned private regular file.');
}

async function readStat(pid: number): Promise<Basic5LinuxProcessSnapshot | undefined> {
  let contents: string;
  try {
    contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') return undefined;
    if (code === 'EACCES' || code === 'EPERM')
      throw new Basic5CiProcessProofError('process_stat_permission_denied');
    throw new Basic5CiProcessProofError('process_stat_unavailable');
  }
  try {
    return parseBasic5LinuxProcessStat(pid, contents);
  } catch {
    throw new Basic5CiProcessProofError('process_stat_malformed');
  }
}

export async function readBasic5LinuxProcessSnapshot(): Promise<
  Map<number, Basic5LinuxProcessSnapshot>
> {
  assertLinux();
  let entries: string[];
  try {
    entries = await readdir('/proc');
  } catch {
    throw new Basic5CiProcessProofError('process_census_unavailable');
  }
  const snapshot = new Map<number, Basic5LinuxProcessSnapshot>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const identity = await readStat(pid);
    if (identity) snapshot.set(pid, identity);
  }
  return snapshot;
}

export async function readBasic5LinuxProcessIdentity(
  pid: number,
): Promise<Basic5CiProcessIdentity | undefined> {
  assertLinux();
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid Linux process ID.');
  const before = await readStat(pid);
  if (!before) return undefined;
  if (before.pgid <= 0 || before.sid <= 0)
    throw new Basic5CiProcessProofError('owned_process_identity_ineligible');
  let exe: string;
  try {
    exe = await realpath(`/proc/${pid}/exe`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') {
      const afterFailure = await readStat(pid);
      if (!afterFailure) return undefined;
      if (!sameProcess(before, afterFailure))
        throw new Basic5CiProcessProofError('process_identity_changed');
      throw new Basic5CiProcessProofError('process_executable_unavailable');
    }
    if (code === 'EACCES' || code === 'EPERM')
      throw new Basic5CiProcessProofError('process_executable_permission_denied');
    throw new Basic5CiProcessProofError('process_executable_unavailable');
  }
  const after = await readStat(pid);
  if (!after) return undefined;
  let linkTarget: string;
  try {
    linkTarget = await readlink(`/proc/${pid}/exe`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ESRCH') {
      const afterFailure = await readStat(pid);
      if (!afterFailure) return undefined;
      if (!sameProcess(before, afterFailure))
        throw new Basic5CiProcessProofError('process_identity_changed');
      throw new Basic5CiProcessProofError('process_executable_unavailable');
    }
    if (code === 'EACCES' || code === 'EPERM')
      throw new Basic5CiProcessProofError('process_executable_permission_denied');
    throw new Basic5CiProcessProofError('process_executable_unavailable');
  }
  if (!sameProcess(before, after) || path.resolve(linkTarget) !== exe)
    throw new Basic5CiProcessProofError('process_identity_changed');
  return { ...after, exe };
}

export async function readBasic5CiProcessRegistry(
  filePath: string,
): Promise<Basic5CiProcessRecord[]> {
  assertLinux();
  if (!path.isAbsolute(filePath)) throw new Error('BASIC5 CI registry file path must be absolute.');
  await assertPrivateRegistryFile(filePath, process.getuid?.() ?? -1);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > BASIC5_CI_PROCESS_FILE_BYTE_LIMIT
    )
      throw new Error('BASIC5 CI process registry changed during verification.');
    const raw = await handle.readFile('utf8');
    await assertPrivateRegistryFile(filePath, process.getuid?.() ?? -1);
    return parseBasic5CiProcessRegistryText(raw);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BASIC5 CI')) throw error;
    throw new Error('Could not safely read the BASIC5 CI process registry.');
  } finally {
    await handle?.close();
  }
}

export async function createBasic5CiProcessRegistry(
  filePath: string,
): Promise<Basic5CiProcessRegistry> {
  assertLinux();
  if (!path.isAbsolute(filePath)) throw new Error('BASIC5 CI registry file path must be absolute.');
  const directory = path.dirname(filePath);
  await assertPrivateDirectory(directory);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      filePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)
      throw new Error('BASIC5 CI process registry was not created with private ownership.');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('BASIC5 CI')) throw error;
    throw new Error('BASIC5 CI process registry already exists or could not be created safely.');
  } finally {
    await handle?.close();
  }

  return {
    async register(role, pid, port) {
      if (!roles.has(role)) throw new Error('Unknown BASIC5 CI process role.');
      const identity = await readBasic5LinuxProcessIdentity(pid);
      if (!identity)
        throw new Error('Registered BASIC5 CI process exited before identity capture.');
      const record = parseRecord({
        version: 1,
        role,
        ...identity,
        ...(port === undefined ? {} : { port }),
      });
      const records = await readBasic5CiProcessRegistry(filePath);
      if (records.some((existing) => existing.role === role))
        throw new Error('BASIC5 CI process role is already registered.');
      if (records.length >= BASIC5_CI_PROCESS_RECORD_LIMIT)
        throw new Error('BASIC5 CI process registry record limit exceeded.');
      const existingPid = records.find((existing) => existing.pid === pid);
      if (existingPid && (!sameProcess(existingPid, record) || existingPid.exe !== record.exe))
        throw new Error('BASIC5 CI process registry reuses a PID with conflicting identity.');
      const line = `${JSON.stringify(record)}\n`;
      await assertPrivateRegistryFile(filePath, process.getuid?.() ?? -1);
      let output: Awaited<ReturnType<typeof open>> | undefined;
      try {
        output = await open(
          filePath,
          constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
        );
        const info = await output.stat();
        if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600)
          throw new Error('BASIC5 CI process registry changed during append.');
        if (Buffer.byteLength(line) + info.size > BASIC5_CI_PROCESS_FILE_BYTE_LIMIT)
          throw new Error('BASIC5 CI process registry byte limit exceeded.');
        await output.writeFile(line, 'utf8');
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('BASIC5 CI')) throw error;
        throw new Error('Could not safely append the BASIC5 CI process registry.');
      } finally {
        await output?.close();
      }
      return record;
    },
    records: () => readBasic5CiProcessRegistry(filePath),
  };
}

export function selectBasic5CiBrowserProcess(
  before: ReadonlyMap<number, Basic5LinuxProcessSnapshot>,
  after: ReadonlyMap<number, Basic5CiProcessIdentity>,
  parentPid: number,
): Basic5CiProcessIdentity {
  const newDirectChildren = [...after.values()].filter((processInfo) => {
    const previous = before.get(processInfo.pid);
    return (
      processInfo.ppid === parentPid &&
      (!previous || previous.startTimeTicks !== processInfo.startTimeTicks)
    );
  });
  if (newDirectChildren.length !== 1 || newDirectChildren[0]?.exe !== BASIC5_CI_CHROME_EXECUTABLE)
    throw new Error('Expected exactly one new direct child for the allowlisted CI Chrome channel.');
  return newDirectChildren[0] as Basic5CiProcessIdentity;
}

export function assertBasic5CiProcessClosure(
  records: readonly Basic5CiProcessRecord[],
  liveProcesses: ReadonlyMap<number, Basic5LinuxProcessSnapshot>,
  listeningPorts: ReadonlySet<number>,
): void {
  for (const record of records) {
    const live = liveProcesses.get(record.pid);
    if (live?.startTimeTicks === record.startTimeTicks)
      throw new Error(`Registered BASIC5 process role ${record.role} is still alive.`);
    if (record.port !== undefined && listeningPorts.has(record.port))
      throw new Error(`Registered BASIC5 process role ${record.role} still owns a listener.`);
  }
}

export function assertBasic5CiProcessRegistryComplete(
  records: readonly Basic5CiProcessRecord[],
): void {
  assertCompleteRecords(records);
}
