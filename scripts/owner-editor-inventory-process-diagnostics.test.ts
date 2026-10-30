import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  InventoryLimitError,
  InventoryListError,
  InventoryProcessError,
  inventoryFailureDiagnostic,
  parseInventoryList,
} from './owner-editor-inventory-diagnostics.js';

const exec = promisify(execFile);
const secret = 'DO_NOT_LEAK_private-owner-token-path';
const diagnostic = (error: unknown) => inventoryFailureDiagnostic('cli_composites', error);
async function failure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('Expected fake subprocess failure');
}
function closed(result: unknown) {
  expect(result).toMatchObject({
    readiness: 'unknown',
    authorityEstablished: false,
    mutationAuthorized: false,
  });
  expect(JSON.stringify(result)).not.toContain(secret);
}

describe('sanitized subprocess and list failure details', () => {
  it.each([
    ['unrecognized arguments', 'argument_rejected'],
    ['invalid_grant', 'auth_exchange_failed'],
    ['There was a problem refreshing your current auth tokens', 'auth_exchange_failed'],
    ['PERMISSION_DENIED', 'permission_denied'],
    ['NOT_FOUND', 'resource_not_found'],
    [secret, 'unknown'],
  ])('turns fake subprocess stderr %s into a fixed hint', async (hint, expected) => {
    const error = await failure(() =>
      exec(process.execPath, [
        '-e',
        `process.stderr.write(${JSON.stringify(`${secret} ${hint} ${secret}`)});process.exit(2)`,
      ]),
    );
    const wrapped = new InventoryProcessError(error);
    expect(Object.keys(wrapped).sort()).toEqual([
      'causeHint',
      'exitCode',
      'processFailure',
      'signalClass',
    ]);
    expect(JSON.stringify(wrapped)).not.toContain(secret);
    const result = diagnostic(wrapped);
    expect(result).toMatchObject({
      errorClass: 'ProcessError',
      processFailure: 'nonzero_exit',
      exitCode: 2,
      signalClass: null,
      causeHint: expected,
      diagnosticHintsOnly: true,
    });
    closed(result);
  });
  it.each(['spawn', 'timeout', 'buffer'] as const)(
    'classifies an actual fake %s subprocess failure',
    async (mode) => {
      const error = await failure(() =>
        mode === 'spawn'
          ? exec(`/no-such-inventory-fake-executable/${secret}`, [])
          : exec(
              process.execPath,
              [
                '-e',
                mode === 'timeout'
                  ? 'setInterval(()=>{},1000)'
                  : `process.stdout.write(${JSON.stringify(secret)}.repeat(10000))`,
              ],
              {
                timeout: mode === 'timeout' ? 500 : 5000,
                maxBuffer: mode === 'buffer' ? 128 : 32768,
                killSignal: 'SIGKILL',
              },
            ),
      );
      const result = diagnostic(new InventoryProcessError(error));
      expect(result).toMatchObject({
        processFailure:
          mode === 'spawn' ? 'spawn_failed' : mode === 'timeout' ? 'timeout' : 'output_bound',
        exitCode: null,
        causeHint: mode === 'buffer' ? 'output_bound' : 'unknown',
      });
      closed(result);
    },
  );
  it('reads no hostile/accessor content and does not coerce or copy arbitrary metadata', () => {
    let calls = 0;
    const raw = {};
    for (const key of ['code', 'signal', 'killed', 'stderr', 'message', 'name'])
      Object.defineProperty(raw, key, {
        get() {
          calls++;
          throw new Error(secret);
        },
      });
    const wrapped = new InventoryProcessError(raw);
    expect(diagnostic(wrapped)).toMatchObject({
      processFailure: 'unknown',
      exitCode: null,
      signalClass: null,
      causeHint: 'unknown',
    });
    for (const key of ['processFailure', 'exitCode', 'signalClass', 'causeHint'])
      Object.defineProperty(wrapped, key, {
        get() {
          calls++;
          return secret;
        },
      });
    const result = diagnostic(wrapped);
    expect(result).toMatchObject({
      processFailure: 'unknown',
      exitCode: null,
      signalClass: null,
      causeHint: 'unknown',
    });
    expect(calls).toBe(0);
    closed(result);
    closed(
      diagnostic(
        new InventoryProcessError(
          new Proxy(
            {},
            {
              getOwnPropertyDescriptor() {
                throw new Error(secret);
              },
            },
          ),
        ),
      ),
    );
  });
  it.each(
    [
      -1,
      0,
      256,
      1.5,
      NaN,
      Infinity,
      '2',
      secret,
      {
        toString() {
          throw new Error(secret);
        },
      },
    ].map((code, index) => [index, code] as const),
  )('rejects unvalidated exit metadata case %i', (_index, code) => {
    const result = diagnostic(new InventoryProcessError({ code, signal: secret, stderr: secret }));
    expect(result).toMatchObject({ exitCode: null, signalClass: 'other' });
    closed(result);
  });
  it('revalidates internal error metadata and caps hint scanning', () => {
    const wrapped = new InventoryProcessError({
      code: 2,
      stderr: `${'x'.repeat(65536)}PERMISSION_DENIED`,
    });
    expect(diagnostic(wrapped)).toMatchObject({ causeHint: 'unknown' });
    Object.assign(wrapped, {
      processFailure: secret,
      exitCode: secret,
      signalClass: secret,
      causeHint: secret,
    });
    const result = diagnostic(wrapped);
    expect(result).toMatchObject({
      processFailure: 'unknown',
      exitCode: null,
      signalClass: null,
      causeHint: 'unknown',
    });
    closed(result);
  });
  it('captures each subprocess descriptor once even if a proxy changes subsequent values', () => {
    const reads = new Map<PropertyKey, number>();
    const error = new Proxy(
      { code: 2, signal: null, killed: false, stderr: 'PERMISSION_DENIED' },
      {
        getOwnPropertyDescriptor(target, key) {
          const count = (reads.get(key) ?? 0) + 1;
          reads.set(key, count);
          return count === 1
            ? Object.getOwnPropertyDescriptor(target, key)
            : { configurable: true, value: secret };
        },
      },
    );
    const result = diagnostic(new InventoryProcessError(error));
    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
    expect(result).toMatchObject({
      processFailure: 'nonzero_exit',
      exitCode: 2,
      signalClass: null,
      causeHint: 'permission_denied',
    });
    closed(result);
  });
  it.each([
    [secret, 'invalid_json'],
    [JSON.stringify({ private: secret }), 'not_array'],
    [JSON.stringify(Array(1001).fill(secret)), 'count_bound'],
  ])('reports only fixed parsed-list rejection classes', (raw, expected) => {
    let error: unknown;
    try {
      parseInventoryList(raw);
    } catch (caught) {
      error = caught;
    }
    const result = diagnostic(error);
    expect(result).toMatchObject({ errorClass: 'ListError', listFailure: expected });
    closed(result);
  });
  it('preserves accepted empty and boundary-sized lists and bounded diagnostic validation', () => {
    expect(parseInventoryList('[]')).toEqual([]);
    expect(parseInventoryList(JSON.stringify(Array(1000).fill(null)))).toHaveLength(1000);
    for (const kind of ['time_bound', 'output_bound'] as const) {
      expect(diagnostic(new InventoryLimitError(kind))).toMatchObject({
        errorClass: 'LimitError',
        limitFailure: kind,
      });
    }
    const list = new InventoryListError('not_array');
    Object.defineProperty(list, 'listFailure', {
      get() {
        throw new Error(secret);
      },
    });
    expect(diagnostic(list)).toMatchObject({ listFailure: 'unknown' });
    const limit = new InventoryLimitError('time_bound');
    Object.assign(limit, { limitFailure: secret });
    closed(diagnostic(limit));
    expect(diagnostic(limit)).toMatchObject({ limitFailure: 'unknown' });
  });
});
