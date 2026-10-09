import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sandboxInvocation } from './sandbox.js';

describe('Cloud Run sandbox invocation', () => {
  const workDir = path.resolve('/tmp/code-job-test');
  const inputDir = path.join(workDir, 'input');
  const sourceDir = path.join(workDir, 'source');
  const outputDir = path.join(workDir, 'output');
  const scriptFile = path.join(sourceDir, 'script.mjs');

  it('runs with isolated explicit environment, read-only host inputs, and only a writable output mount', () => {
    const invocation = sandboxInvocation({
      sandboxBinary: '/usr/local/gcp/bin/sandbox',
      workDir,
      inputDir,
      sourceDir,
      outputDir,
      scriptFile,
      language: 'javascript',
    });
    expect(invocation.command).toBe('/usr/local/gcp/bin/sandbox');
    expect(invocation.args).toEqual([
      'do',
      '--write',
      '--mount',
      `type=bind,source=${inputDir},destination=${inputDir},readonly`,
      '--mount',
      `type=bind,source=${sourceDir},destination=${sourceDir},readonly`,
      '--mount',
      `type=bind,source=${outputDir},destination=${outputDir}`,
      '--workdir',
      workDir,
      '--env',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      '--env',
      `HOME=${workDir}`,
      '--env',
      `TMPDIR=${workDir}`,
      '--env',
      `MPLCONFIGDIR=${workDir}`,
      '--',
      process.execPath,
      '--no-warnings',
      scriptFile,
    ]);
    expect(invocation.args).not.toContain('--allow-egress');
  });

  it('fails closed on ambiguous mount paths or paths outside the job directory', () => {
    expect(() =>
      sandboxInvocation({
        sandboxBinary: '/usr/local/gcp/bin/sandbox',
        workDir,
        inputDir,
        sourceDir,
        outputDir: `${workDir}/out,side`,
        scriptFile,
        language: 'javascript',
      }),
    ).toThrow(/option delimiters/);
    expect(() =>
      sandboxInvocation({
        sandboxBinary: '/usr/local/gcp/bin/sandbox',
        workDir,
        inputDir,
        sourceDir,
        outputDir: '/tmp/shared-output',
        scriptFile,
        language: 'javascript',
      }),
    ).toThrow(/inside the job workspace/);
  });
});
