import path from 'node:path';

/** Cloud Run injects this command only when sandboxLauncher is enabled. */
export const CLOUD_RUN_SANDBOX = '/usr/local/gcp/bin/sandbox';

export interface SandboxInvocation {
  command: string;
  args: string[];
}

/**
 * Build the broker-to-sandbox invocation. Only the per-run output directory is
 * mounted writable; the staged script and inputs remain visible through the
 * sandbox's read-only rootfs. No parent environment variables are forwarded.
 */
export function sandboxInvocation(input: {
  sandboxBinary: string;
  workDir: string;
  inputDir: string;
  sourceDir: string;
  outputDir: string;
  scriptFile: string;
  language: 'javascript' | 'python';
}): SandboxInvocation {
  for (const value of [
    input.workDir,
    input.inputDir,
    input.sourceDir,
    input.outputDir,
    input.scriptFile,
  ]) {
    if (!path.isAbsolute(value) || /[,=\r\n]/.test(value))
      throw new Error('sandbox paths must be absolute and cannot contain option delimiters');
  }
  if (
    !input.inputDir.startsWith(`${input.workDir}${path.sep}`) ||
    !input.sourceDir.startsWith(`${input.workDir}${path.sep}`) ||
    !input.outputDir.startsWith(`${input.workDir}${path.sep}`)
  )
    throw new Error('sandbox output must remain inside the job workspace');
  if (!input.scriptFile.startsWith(`${input.sourceDir}${path.sep}`))
    throw new Error('sandbox script must remain inside the job workspace');

  const command = input.language === 'python' ? '/usr/bin/python3' : process.execPath;
  const args = [
    'do',
    '--write',
    '--mount',
    `type=bind,source=${input.inputDir},destination=${input.inputDir},readonly`,
    '--mount',
    `type=bind,source=${input.sourceDir},destination=${input.sourceDir},readonly`,
    '--mount',
    `type=bind,source=${input.outputDir},destination=${input.outputDir}`,
    '--workdir',
    input.workDir,
    '--env',
    'PATH=/usr/local/bin:/usr/bin:/bin',
    '--env',
    `HOME=${input.workDir}`,
    '--env',
    `TMPDIR=${input.workDir}`,
    '--env',
    `MPLCONFIGDIR=${input.workDir}`,
    '--',
    command,
    ...(input.language === 'python' ? [input.scriptFile] : ['--no-warnings', input.scriptFile]),
  ];
  return { command: input.sandboxBinary, args };
}
