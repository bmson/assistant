import { describe, expect, it } from 'vitest';
import {
  assertBasic5CiProcessClosure,
  assertBasic5CiProcessRegistryComplete,
  BASIC5_CI_CHROME_EXECUTABLE,
  type Basic5CiProcessRecord,
  type Basic5LinuxProcessSnapshot,
  parseBasic5CiProcessRegistryText,
  parseBasic5LinuxProcessStat,
  selectBasic5CiBrowserProcess,
} from './basic5-ci-process-proof.js';

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
  it('parses Linux stat fields even when the command name contains spaces or parentheses', () => {
    const fields = ['S', '11', '12', '13', ...Array.from({ length: 15 }, () => '0'), '987654'];
    expect(
      parseBasic5LinuxProcessStat(42, `42 (node (worker) with spaces) ${fields.join(' ')}`),
    ).toEqual({
      pid: 42,
      ppid: 11,
      pgid: 12,
      sid: 13,
      startTimeTicks: '987654',
    });
    expect(() => parseBasic5LinuxProcessStat(42, `43 (wrong pid) ${fields.join(' ')}`)).toThrow(
      'mismatched',
    );
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
