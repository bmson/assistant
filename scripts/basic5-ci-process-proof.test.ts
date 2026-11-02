import { EventEmitter } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Basic5CiUtilityChildTestDriver, RealBasic5CiOps } from './basic5-ci-acceptance.js';
import {
  assertBasic5CiProcessClosure,
  assertBasic5CiProcessRegistryComplete,
  BASIC5_CI_CHROME_EXECUTABLE,
  Basic5CiProcessProofError,
  type Basic5CiProcessRecord,
  type Basic5LinuxProcessSnapshot,
  parseBasic5CiProcessRegistryText,
  parseBasic5LinuxProcessStat,
  readBasic5LinuxProcessIdentity,
  readBasic5LinuxProcessSnapshot,
  selectBasic5CiBrowserProcess,
} from './basic5-ci-process-proof.js';

vi.mock('node:fs/promises', () => ({
  lstat: vi.fn(),
  open: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  readlink: vi.fn(),
  realpath: vi.fn(),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

afterEach(() => {
  vi.resetAllMocks();
  if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
});

function setLinuxPlatformForMockedProcessReads(): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    enumerable: originalPlatform?.enumerable ?? true,
    value: 'linux',
    writable: originalPlatform?.writable ?? false,
  });
}

function statContents(
  pid: number,
  values: {
    state?: string;
    ppid?: number;
    pgid?: number;
    sid?: number;
    startTimeTicks?: string;
  } = {},
): string {
  const fields = [
    values.state ?? 'S',
    String(values.ppid ?? 11),
    String(values.pgid ?? pid),
    String(values.sid ?? pid),
    ...Array.from({ length: 15 }, () => '0'),
    values.startTimeTicks ?? '987654',
  ];
  return `${pid} (node worker) ${fields.join(' ')}`;
}

function proofErrorCode(error: unknown): string | undefined {
  return error instanceof Basic5CiProcessProofError ? error.code : undefined;
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error('redacted OS detail'), { code });
}

async function thrownBy(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to fail.');
}

function mockReadFile(...contents: Array<string | Error>): void {
  vi.mocked(fsPromises.readFile).mockClear();
  vi.mocked(fsPromises.readFile).mockImplementation(async () => {
    const content = contents.shift();
    if (content === undefined) throw new Error('Unexpected stat read.');
    if (content instanceof Error) throw content;
    return content;
  });
}

function expectSafeProofError(error: unknown, expected: string): void {
  expect(proofErrorCode(error)).toBe(expected);
  expect((error as Error).message).not.toContain('redacted OS detail');
}

const worker: Basic5CiProcessRecord = {
  version: 1,
  role: 'fixture-worker',
  pid: 500,
  ppid: 100,
  pgid: 500,
  sid: 100,
  startTimeTicks: '9001',
  exe: '/usr/bin/node',
};

function registryRecords(): Basic5CiProcessRecord[] {
  return [
    worker,
    { ...worker, role: 'embedding', port: 34001 },
    {
      version: 1,
      role: 'web',
      pid: 600,
      ppid: 500,
      pgid: 600,
      sid: 600,
      startTimeTicks: '9002',
      exe: '/usr/bin/node',
      port: 34002,
    },
    {
      version: 1,
      role: 'browser',
      pid: 700,
      ppid: 500,
      pgid: 700,
      sid: 500,
      startTimeTicks: '9003',
      exe: BASIC5_CI_CHROME_EXECUTABLE,
    },
  ];
}

function rawRegistry(records: readonly Basic5CiProcessRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

describe('BASIC5 Linux process proof', () => {
  it('classifies unavailable, denied, and malformed stat observations without exposing OS errors', async () => {
    setLinuxPlatformForMockedProcessReads();
    vi.mocked(fsPromises.readdir).mockResolvedValue(['42'] as never);
    vi.mocked(fsPromises.readFile).mockRejectedValueOnce(codedError('EACCES'));
    expectSafeProofError(
      await thrownBy(readBasic5LinuxProcessSnapshot),
      'process_stat_permission_denied',
    );

    vi.mocked(fsPromises.readFile).mockRejectedValueOnce(codedError('EIO'));
    expectSafeProofError(
      await thrownBy(readBasic5LinuxProcessSnapshot),
      'process_stat_unavailable',
    );

    vi.mocked(fsPromises.readFile).mockResolvedValueOnce('not a stat record');
    expectSafeProofError(await thrownBy(readBasic5LinuxProcessSnapshot), 'process_stat_malformed');

    vi.mocked(fsPromises.readdir).mockRejectedValueOnce(codedError('EACCES'));
    expectSafeProofError(
      await thrownBy(readBasic5LinuxProcessSnapshot),
      'process_census_unavailable',
    );
  });

  it('rejects zero group or session IDs for owned identities while retaining them in global snapshots', async () => {
    setLinuxPlatformForMockedProcessReads();
    vi.mocked(fsPromises.readdir).mockResolvedValue(['42'] as never);
    mockReadFile(statContents(42, { pgid: 0, sid: 0 }));
    await expect(readBasic5LinuxProcessSnapshot()).resolves.toEqual(
      new Map([[42, { pid: 42, state: 'S', ppid: 11, pgid: 0, sid: 0, startTimeTicks: '987654' }]]),
    );

    for (const field of ['pgid', 'sid'] as const) {
      mockReadFile(statContents(42, { [field]: 0 }));
      const error = await thrownBy(() => readBasic5LinuxProcessIdentity(42));
      expectSafeProofError(error, 'owned_process_identity_ineligible');
      expect(fsPromises.realpath).not.toHaveBeenCalled();
    }
  });

  it('treats executable lookup disappearance as gone only when the PID is absent on reread', async () => {
    setLinuxPlatformForMockedProcessReads();
    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('ENOENT'));
    mockReadFile(statContents(42), codedError('ESRCH'));
    await expect(readBasic5LinuxProcessIdentity(42)).resolves.toBeUndefined();
    expect(fsPromises.readFile).toHaveBeenCalledTimes(2);

    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('ESRCH'));
    mockReadFile(statContents(42), statContents(42));
    const error = await thrownBy(() => readBasic5LinuxProcessIdentity(42));
    expectSafeProofError(error, 'process_executable_unavailable');
    expect(fsPromises.readFile).toHaveBeenCalledTimes(2);
  });

  it('recognizes only a disappeared executable for an unchanged known zombie identity', async () => {
    setLinuxPlatformForMockedProcessReads();
    const enrolled = {
      pid: 42,
      ppid: 11,
      pgid: 42,
      sid: 42,
      startTimeTicks: '987654',
      exe: '/usr/bin/node',
    };

    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('ENOENT'));
    mockReadFile(statContents(42), statContents(42, { state: 'Z' }));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42, enrolled)),
      'known_process_terminal',
    );
    expect(fsPromises.readFile).toHaveBeenCalledTimes(2);

    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('ESRCH'));
    mockReadFile(statContents(42, { state: 'Z' }), statContents(42, { state: 'Z' }));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42, enrolled)),
      'known_process_terminal',
    );
    expect(fsPromises.readFile).toHaveBeenCalledTimes(2);

    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('ENOENT'));
    mockReadFile(statContents(42, { state: 'Z' }), statContents(42, { state: 'Z' }));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42)),
      'process_executable_unavailable',
    );

    vi.mocked(fsPromises.realpath).mockResolvedValueOnce('/usr/bin/node');
    vi.mocked(fsPromises.readlink).mockRejectedValueOnce(codedError('ENOENT'));
    mockReadFile(
      statContents(42, { state: 'Z' }),
      statContents(42, { state: 'Z' }),
      statContents(42, { state: 'Z' }),
    );
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42, enrolled)),
      'known_process_terminal',
    );
  });

  it('returns the unchanged state-free registry identity shape for a live process', async () => {
    setLinuxPlatformForMockedProcessReads();
    vi.mocked(fsPromises.realpath).mockResolvedValueOnce('/usr/bin/node');
    vi.mocked(fsPromises.readlink).mockResolvedValueOnce('/usr/bin/node');
    mockReadFile(statContents(42), statContents(42));

    const identity = await readBasic5LinuxProcessIdentity(42);
    expect(identity).toEqual({
      pid: 42,
      ppid: 11,
      pgid: 42,
      sid: 42,
      startTimeTicks: '987654',
      exe: '/usr/bin/node',
    });
    expect(identity && Object.hasOwn(identity, 'state')).toBe(false);
    expect(identity && Object.keys(identity).sort()).toEqual([
      'exe',
      'pgid',
      'pid',
      'ppid',
      'sid',
      'startTimeTicks',
    ]);
  });

  it('integrates real proof reads with the behavioral runner across a known zombie transition', async () => {
    setLinuxPlatformForMockedProcessReads();
    const pid = 88;
    let alive = true;
    vi.mocked(fsPromises.readdir).mockImplementation(async () => (alive ? ['88'] : []) as never);
    mockReadFile(
      statContents(pid, { ppid: process.pid, pgid: pid, sid: pid, startTimeTicks: '1' }),
      statContents(pid, { ppid: process.pid, pgid: pid, sid: pid, startTimeTicks: '1' }),
      statContents(pid, { ppid: process.pid, pgid: pid, sid: pid, startTimeTicks: '1' }),
      statContents(pid, {
        state: 'Z',
        ppid: process.pid,
        pgid: pid,
        sid: pid,
        startTimeTicks: '1',
      }),
      statContents(pid, {
        state: 'Z',
        ppid: process.pid,
        pgid: pid,
        sid: pid,
        startTimeTicks: '1',
      }),
    );
    vi.mocked(fsPromises.realpath)
      .mockResolvedValueOnce('/synthetic/node')
      .mockRejectedValueOnce(codedError('ENOENT'));
    vi.mocked(fsPromises.readlink).mockResolvedValueOnce('/synthetic/node');

    class MockDirectChild extends EventEmitter {
      pid = 88;
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      kill = vi.fn(() => true);
    }
    const child = new MockDirectChild();
    const killProcess = vi.fn();
    const proof = {
      BASIC5_CI_CHROME_EXECUTABLE,
      readBasic5LinuxProcessSnapshot,
      readBasic5LinuxProcessIdentity,
      readBasic5CiProcessRegistry: vi.fn(async () => []),
      assertBasic5CiProcessRegistryComplete: vi.fn(),
      assertBasic5CiProcessClosure: vi.fn(),
    } as unknown as Basic5CiUtilityChildTestDriver['proof'];
    const driver: Basic5CiUtilityChildTestDriver = {
      proof,
      now: () => 100,
      spawn: vi.fn(() => child) as unknown as Basic5CiUtilityChildTestDriver['spawn'],
      sleep: async () => {
        alive = false;
        child.emit('close', 0, null);
      },
      killProcess,
    };
    const ops = new RealBasic5CiOps(driver);
    try {
      const result = await (
        ops as unknown as {
          runChild(
            command: string,
            args: string[],
            env: NodeJS.ProcessEnv,
            deadline: number,
            label: string,
            signal: AbortSignal,
          ): Promise<{ exitCode: number; utilityDiagnostic?: unknown }>;
        }
      ).runChild('/synthetic/node', [], {}, 10_000, 'basic5-vitest', new AbortController().signal);
      expect(result.exitCode).toBe(0);
      expect(result.utilityDiagnostic).toBeUndefined();
      expect(fsPromises.readdir).toHaveBeenCalledTimes(3);
      expect(fsPromises.readFile).toHaveBeenCalledTimes(5);
      expect(fsPromises.realpath).toHaveBeenCalledTimes(2);
      expect(fsPromises.readlink).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
      expect(killProcess).not.toHaveBeenCalled();
    } finally {
      ops.dispose();
    }
    expect(alive).toBe(false);
  });

  it('holds on zombie tuple changes, live executable paths, and permission failures', async () => {
    setLinuxPlatformForMockedProcessReads();
    const enrolled = {
      pid: 42,
      ppid: 11,
      pgid: 42,
      sid: 42,
      startTimeTicks: '987654',
      exe: '/usr/bin/node',
    };

    for (const changed of [{ startTimeTicks: '987655' }, { ppid: 12 }, { pgid: 43 }, { sid: 43 }]) {
      vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('ENOENT'));
      mockReadFile(statContents(42), statContents(42, { ...changed, state: 'Z' }));
      expectSafeProofError(
        await thrownBy(() => readBasic5LinuxProcessIdentity(42, enrolled)),
        'process_identity_changed',
      );
    }

    vi.mocked(fsPromises.realpath).mockResolvedValueOnce('/usr/bin/node');
    vi.mocked(fsPromises.readlink).mockResolvedValueOnce('/usr/bin/node');
    mockReadFile(statContents(42, { state: 'Z' }), statContents(42, { state: 'Z' }));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42, enrolled)),
      'owned_process_identity_ineligible',
    );

    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('ENOENT'));
    mockReadFile(statContents(42), codedError('EACCES'));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42, enrolled)),
      'process_stat_permission_denied',
    );
  });

  it('classifies executable identity replacement and permission failures conservatively', async () => {
    setLinuxPlatformForMockedProcessReads();
    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('ENOENT'));
    mockReadFile(statContents(42), statContents(42, { startTimeTicks: '987655' }));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42)),
      'process_identity_changed',
    );

    vi.mocked(fsPromises.realpath).mockClear();
    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('EACCES'));
    mockReadFile(statContents(42));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42)),
      'process_executable_permission_denied',
    );

    vi.mocked(fsPromises.realpath).mockClear();
    vi.mocked(fsPromises.realpath).mockRejectedValueOnce(codedError('EIO'));
    mockReadFile(statContents(42));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42)),
      'process_executable_unavailable',
    );
  });

  it('rechecks a process when executable-link lookup disappears and detects identity changes', async () => {
    setLinuxPlatformForMockedProcessReads();
    vi.mocked(fsPromises.realpath).mockResolvedValue('/usr/bin/node');
    vi.mocked(fsPromises.readlink).mockRejectedValueOnce(codedError('ENOENT'));
    mockReadFile(statContents(42), statContents(42), statContents(42));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42)),
      'process_executable_unavailable',
    );
    expect(fsPromises.readFile).toHaveBeenCalledTimes(3);

    vi.mocked(fsPromises.readFile).mockClear();
    vi.mocked(fsPromises.realpath).mockResolvedValue('/usr/bin/node');
    vi.mocked(fsPromises.readlink).mockResolvedValue('/usr/bin/node');
    mockReadFile(statContents(42), statContents(42, { pgid: 43 }));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42)),
      'process_identity_changed',
    );

    vi.mocked(fsPromises.realpath).mockResolvedValue('/usr/bin/node');
    vi.mocked(fsPromises.readlink).mockRejectedValueOnce(codedError('EPERM'));
    mockReadFile(statContents(42), statContents(42));
    expectSafeProofError(
      await thrownBy(() => readBasic5LinuxProcessIdentity(42)),
      'process_executable_permission_denied',
    );
  });

  it('parses Linux stat fields even when the command name contains spaces or parentheses', () => {
    const fields = ['S', '11', '12', '13', ...Array.from({ length: 15 }, () => '0'), '987654'];
    expect(
      parseBasic5LinuxProcessStat(42, `42 (node (worker) with spaces) ${fields.join(' ')}`),
    ).toEqual({
      pid: 42,
      state: 'S',
      ppid: 11,
      pgid: 12,
      sid: 13,
      startTimeTicks: '987654',
    });
    expect(() => parseBasic5LinuxProcessStat(42, `43 (wrong pid) ${fields.join(' ')}`)).toThrow(
      expect.objectContaining({ code: 'process_stat_malformed' }),
    );
  });

  it('keeps zero group/session values visible in global stat snapshots but rejects negative values', () => {
    const fields = ['S', '11', '0', '0', ...Array.from({ length: 15 }, () => '0'), '987654'];
    expect(parseBasic5LinuxProcessStat(42, `42 (kernel worker) ${fields.join(' ')}`)).toEqual({
      pid: 42,
      state: 'S',
      ppid: 11,
      pgid: 0,
      sid: 0,
      startTimeTicks: '987654',
    });
    expect(() =>
      parseBasic5LinuxProcessStat(
        42,
        `42 (malformed negative group) ${[...fields.slice(0, 2), '-1', ...fields.slice(3)].join(' ')}`,
      ),
    ).toThrow(expect.objectContaining({ code: 'process_stat_malformed' }));
    expect(() =>
      parseBasic5LinuxProcessStat(
        42,
        `42 (malformed negative session) ${[...fields.slice(0, 3), '-1', ...fields.slice(4)].join(' ')}`,
      ),
    ).toThrow(expect.objectContaining({ code: 'process_stat_malformed' }));
    expect(() =>
      parseBasic5LinuxProcessStat(42, `42 (unknown state) ${['?', ...fields.slice(1)].join(' ')}`),
    ).toThrow(expect.objectContaining({ code: 'process_stat_malformed' }));
  });

  it('requires exactly the one fresh direct child and exact allowlisted Chrome executable', () => {
    const before = new Map<number, Basic5LinuxProcessSnapshot>([
      [500, { pid: 500, ppid: 100, pgid: 500, sid: 100, startTimeTicks: '9001' }],
    ]);
    const chrome = {
      pid: 700,
      ppid: 500,
      pgid: 700,
      sid: 500,
      startTimeTicks: '9003',
      exe: BASIC5_CI_CHROME_EXECUTABLE,
    };
    expect(selectBasic5CiBrowserProcess(before, new Map([[700, chrome]]), 500)).toEqual(chrome);
    expect(() =>
      selectBasic5CiBrowserProcess(
        before,
        new Map([[700, { ...chrome, exe: '/usr/bin/chromium' }]]),
        500,
      ),
    ).toThrow('allowlisted CI Chrome');
    expect(() =>
      selectBasic5CiBrowserProcess(
        before,
        new Map([
          [700, chrome],
          [701, { ...chrome, pid: 701, pgid: 701, startTimeTicks: '9004' }],
        ]),
        500,
      ),
    ).toThrow('exactly one new direct child');
  });

  it('parses bounded strict records and allows the worker PID to own the embedding listener role', () => {
    const records = registryRecords();
    expect(parseBasic5CiProcessRegistryText(rawRegistry(records))).toEqual(records);
    expect(() => parseBasic5CiProcessRegistryText(rawRegistry(records.slice(0, 3)))).not.toThrow();
    expect(() =>
      parseBasic5CiProcessRegistryText(rawRegistry([...records, { ...worker }])),
    ).toThrow('repeats a logical role');
    expect(() =>
      parseBasic5CiProcessRegistryText(
        rawRegistry([worker, { ...worker, role: 'embedding', exe: '/usr/bin/other' }]),
      ),
    ).toThrow('reuses a PID with conflicting identity');
    expect(() => parseBasic5CiProcessRegistryText(`${rawRegistry(records)}{"version":1}`)).toThrow(
      'partial final record',
    );
    expect(() =>
      parseBasic5CiProcessRegistryText(
        `${JSON.stringify({ ...records[0], secret: 'forbidden-field' })}\n`,
      ),
    ).toThrow('strict validation');
    expect(() => assertBasic5CiProcessRegistryComplete(records.slice(0, 3))).toThrow(
      'four required process roles',
    );
    expect(() => assertBasic5CiProcessRegistryComplete(records)).not.toThrow();
  });

  it('rejects zero group/session values in explicitly registered owned identities', () => {
    for (const field of ['pgid', 'sid'] as const) {
      expect(() =>
        parseBasic5CiProcessRegistryText(rawRegistry([{ ...worker, [field]: 0 }])),
      ).toThrow('strict validation');
    }
  });

  it('fails closed on an exact registered PID/start-time or still-open registered listener', () => {
    const records = registryRecords();
    const live = new Map<number, Basic5LinuxProcessSnapshot>([
      [600, { pid: 600, ppid: 500, pgid: 600, sid: 600, startTimeTicks: '9002' }],
      [700, { pid: 700, ppid: 500, pgid: 700, sid: 500, startTimeTicks: 'different-generation' }],
    ]);
    expect(() => assertBasic5CiProcessClosure(records.slice(1), live, new Set())).toThrow(
      'role web is still alive',
    );
    expect(() =>
      assertBasic5CiProcessClosure(records.slice(1), new Map(), new Set([34001])),
    ).toThrow('still owns a listener');
    expect(() =>
      assertBasic5CiProcessClosure(records.slice(1), new Map(), new Set()),
    ).not.toThrow();
  });

  it('rejects oversized process registries before retaining their contents', () => {
    expect(() => parseBasic5CiProcessRegistryText('x'.repeat(64 * 1024 + 1))).toThrow('byte limit');
  });
});
