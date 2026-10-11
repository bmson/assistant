import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(sourceDirectory, '../../..');
const coreSourceRoot = resolve(repositoryRoot, 'packages/core/src');
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

function resolveCoreImport(specifier: string, importingFile: string): string | null {
  if (specifier === '@assistant/core/workflow/request-checklist')
    return resolve(coreSourceRoot, 'workflow/request-checklist.ts');
  if (specifier === '@assistant/core/workflow/request-checklist-schema')
    return resolve(coreSourceRoot, 'workflow/request-checklist-schema.ts');
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(importingFile), specifier.replace(/\.js$/, '.ts'));
  return extname(target) === '.ts' ? target : null;
}

describe('checklist correction runtime module boundary', () => {
  it('keeps Firestore correction off the core root barrel and its database/provider graph', () => {
    const firestoreAdapter = resolve(sourceDirectory, 'task-activity-commands.ts');
    expect(runtimeImports(firestoreAdapter)).not.toContain('@assistant/core');
    expect(runtimeImports(firestoreAdapter)).toContain(
      '@assistant/core/workflow/request-checklist',
    );

    const queue = [resolve(coreSourceRoot, 'workflow/request-checklist.ts')];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      for (const specifier of runtimeImports(current)) {
        expect(specifier).not.toMatch(/^@assistant\/(?:db|config)(?:\/|$)/);
        expect(specifier).not.toMatch(/(?:^|\/)model-router(?:\/|$)/);
        expect(specifier).not.toMatch(/provider|model-config/i);
        const next = resolveCoreImport(specifier, current);
        if (next) queue.push(next);
      }
    }
    expect([...visited].some((path) => path.endsWith('/src/index.ts'))).toBe(false);
    expect(visited).toContain(resolve(coreSourceRoot, 'workflow/saved-work-evidence.ts'));
  });

  it('keeps the bundled Firestore correction adapter out of database and model runtime modules', async () => {
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
    expect(bundledInputs.some((path) => path.includes('packages/core/src/index.ts'))).toBe(false);
    expect(
      bundledInputs.filter((path) =>
        /packages\/(?:db|config)\/|model-router|\/provider(?:\/|\.)|model-config/i.test(path),
      ),
    ).toEqual([]);
    expect(
      bundledInputs.some((path) =>
        path.endsWith('packages/core/src/workflow/request-checklist.ts'),
      ),
    ).toBe(true);
    expect(
      bundledInputs.some((path) =>
        path.endsWith('packages/core/src/workflow/saved-work-evidence.ts'),
      ),
    ).toBe(true);
  });
});
