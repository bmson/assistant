import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistSecretEnvValue } from './persist-secret-env.js';

describe('private local secret rotation', () => {
  it('keeps the env and single previous backup private under umask 022', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assistant-env-'));
    const path = join(dir, '.env');
    const oldMask = process.umask(0o022);
    try {
      writeFileSync(path, 'OTHER_SECRET=preserved\nMOBILE_API_TOKEN=old\n', { mode: 0o600 });
      writeFileSync(`${path}.bak`, 'stale', { mode: 0o644 });
      expect(persistSecretEnvValue(path, 'MOBILE_API_TOKEN', 'new')).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}.bak`).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('OTHER_SECRET=preserved\nMOBILE_API_TOKEN=new\n');
      expect(readFileSync(`${path}.bak`, 'utf8')).toContain('MOBILE_API_TOKEN=old');
      chmodSync(path, 0o644);
      persistSecretEnvValue(path, 'MOBILE_API_TOKEN', 'next');
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(`${path}.bak`, 'utf8')).toContain('MOBILE_API_TOKEN=new');
      writeFileSync(`${path}.lock`, 'another writer', { mode: 0o600 });
      expect(() => persistSecretEnvValue(path, 'MOBILE_API_TOKEN', 'racing')).toThrow();
      expect(readFileSync(path, 'utf8')).toContain('MOBILE_API_TOKEN=next');
    } finally {
      process.umask(oldMask);
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects injected lines and does not create absent configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assistant-env-'));
    try {
      expect(persistSecretEnvValue(join(dir, '.env'), 'MOBILE_API_TOKEN', 'new')).toBe(false);
      expect(() =>
        persistSecretEnvValue(join(dir, '.env'), 'MOBILE_API_TOKEN', 'new\nOTHER=evil'),
      ).toThrow();
      mkdirSync(join(dir, '.env'));
      expect(() => persistSecretEnvValue(join(dir, '.env'), 'MOBILE_API_TOKEN', 'new')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
