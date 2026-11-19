import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXED_METADATA } from './owner-archived-runtime-hosted.js';

const cli = fileURLToPath(new URL('./owner-archived-runtime-pack-local.ts', import.meta.url));

describe('offline archive packer command', () => {
  it.each([false, true])('rejects an unreviewed pack with preexisting output=%s', (preexisting) => {
    const temp = mkdtempSync(join(tmpdir(), 'archive-packer-test-'));
    try {
      const source = join(temp, 'source');
      const output = join(temp, 'output');
      mkdirSync(join(source, 'blobs', 'sha256'), { recursive: true });
      for (const name of FIXED_METADATA) {
        const path = join(source, name);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, 'synthetic unreviewed input');
      }
      if (preexisting) writeFileSync(output, 'prior content');
      const result = spawnSync(
        process.execPath,
        ['--import', 'tsx', cli, '--pack', source, output],
        {
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr.trim()).toBe('Archived runtime pack rejected');
      if (preexisting) expect(readFileSync(output, 'utf8')).toBe('prior content');
      else expect(existsSync(output)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
