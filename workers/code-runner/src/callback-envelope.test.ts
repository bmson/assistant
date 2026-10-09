import { describe, expect, it } from 'vitest';
import { CALLBACK_BYTE_LIMIT, callbackEnvelope } from './callback-envelope.js';

describe('code callback byte contract', () => {
  it.each(['x', '🙂', '\u0000', '\\"\n'])(
    'bounds complete escaped UTF-8 output for %j',
    (character) => {
      const result = {
        ok: false,
        exitCode: 19,
        stdout: character.repeat(256 * 1024),
        stderr: character.repeat(256 * 1024),
        outputs: Array.from({ length: 50 }, (_, i) => `code/task/${i}-${'🙂'.repeat(120)}.txt`),
        goal: 'goal '.repeat(700),
        logs: { stdout: { path: 'code/task/logs/captured.txt', capturedBytes: 262144 } },
      };
      const body = callbackEnvelope('task', 't'.repeat(128), result);
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(CALLBACK_BYTE_LIMIT);
      const decoded = JSON.parse(body);
      expect(decoded.result).toMatchObject({
        ok: false,
        exitCode: 19,
        outputs: result.outputs,
        goal: result.goal,
        logs: result.logs,
      });
      expect(result.stdout.startsWith(decoded.result.stdout)).toBe(true);
      expect(result.stderr.startsWith(decoded.result.stderr)).toBe(true);
      expect(decoded.result.logPreview).toMatchObject({
        stdoutPreviewTruncated: true,
        stderrPreviewTruncated: true,
      });
    },
  );
  it('does not truncate small results or silently remove oversized metadata', () => {
    expect(
      JSON.parse(callbackEnvelope('task', 'token', { stdout: 'ok', stderr: '', exitCode: 0 }))
        .result,
    ).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(() =>
      callbackEnvelope('task', 'token', {
        stdout: '',
        stderr: '',
        outputs: ['x'.repeat(CALLBACK_BYTE_LIMIT)],
      }),
    ).toThrow('metadata exceeds');
  });
});
