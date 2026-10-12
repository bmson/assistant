import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, '../../..');
const esbuild = createRequire(resolve(repositoryRoot, 'apps/agent/package.json'))('esbuild') as {
  build(options: Record<string, unknown>): Promise<{
    metafile?: { inputs: Record<string, unknown> };
  }>;
};

function runtimeImports(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const imports = source.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm);
  const output: string[] = [];
  for (const match of imports) {
    const clause = match[1]?.trim() ?? '';
    const onlyTypeBindings =
      clause.startsWith('{') && clause.endsWith('}')
        ? clause
            .slice(1, -1)
            .split(',')
            .every((binding) => binding.trim().startsWith('type '))
        : false;
    if (!clause || clause.startsWith('type ') || onlyTypeBindings) continue;
    if (match[2]) output.push(match[2]);
  }
  return output;
}

describe('checklist correction runtime module boundary', () => {
  it('keeps Firestore correction on its persistence port and out of core', () => {
    const firestoreAdapter = resolve(sourceDirectory, 'task-activity-commands.ts');
    const imports = runtimeImports(firestoreAdapter);
    expect(imports).not.toContain('@assistant/core');
    expect(imports.some((specifier) => specifier.startsWith('@assistant/core/'))).toBe(false);
    expect(imports).toContain('@assistant/persistence');
  });

  it('keeps the bundled Firestore correction adapter out of core, database, and model modules', async () => {
    const result = await esbuild.build({
      absWorkingDir: repositoryRoot,
      entryPoints: [resolve(sourceDirectory, 'task-activity-commands.ts')],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'node',
      format: 'esm',
      external: ['@google-cloud/firestore'],
    });
    const bundledInputs = Object.keys(result.metafile?.inputs ?? {});
    expect(bundledInputs.some((path) => path.startsWith('packages/core/'))).toBe(false);
    expect(
      bundledInputs.filter((path) =>
        /packages\/(?:db|config)\/|model-router|\/provider(?:\/|\.)|model-config/i.test(path),
      ),
    ).toEqual([]);
  });
});
