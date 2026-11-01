import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Firestore cleanup dependency compatibility', () => {
  it('keeps rimraf glob cleanup working through patched glob in a temp tree', async () => {
    const require = createRequire(import.meta.url);
    const firestoreRequire = createRequire(require.resolve('@google-cloud/firestore/package.json'));
    const firestoreApiRequire = createRequire(
      firestoreRequire.resolve('@google-cloud/firestore-api/package.json'),
    );
    const googleGaxRequire = createRequire(firestoreApiRequire.resolve('google-gax'));
    const rimrafRequire = createRequire(googleGaxRequire.resolve('rimraf/package.json'));
    const globRequire = createRequire(rimrafRequire.resolve('glob/package.json'));
    const rimraf = rimrafRequire('rimraf') as {
      rimrafSync: (
        pattern: string,
        options: { glob: { dot: boolean; ignore: string[] } },
      ) => boolean;
    };
    const globPackage = globRequire('glob/package.json') as { version: string };
    const root = await mkdtemp(join(tmpdir(), 'assistant-rimraf-glob-'));

    try {
      await mkdir(join(root, 'nested', 'excluded'), { recursive: true });
      await writeFile(join(root, 'nested', 'remove.tmp'), 'remove');
      await writeFile(join(root, 'nested', '.remove-hidden.tmp'), 'remove');
      await writeFile(join(root, 'nested', 'excluded', 'keep.tmp'), 'keep');

      expect(globPackage.version).toBe('14.0.2');
      expect(
        rimraf.rimrafSync(join(root, '**/*.tmp'), {
          glob: { dot: true, ignore: ['**/excluded/**'] },
        }),
      ).toBe(true);
      expect(existsSync(join(root, 'nested', 'remove.tmp'))).toBe(false);
      expect(existsSync(join(root, 'nested', '.remove-hidden.tmp'))).toBe(false);
      expect(existsSync(join(root, 'nested', 'excluded', 'keep.tmp'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
