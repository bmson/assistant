import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('agent image runtime dependency closure', () => {
  it('pins only the filesystem-sensitive externals in the locked workspace', () => {
    const runtime = JSON.parse(
      readFileSync(resolve(root, 'apps/agent/runtime-dependencies/package.json'), 'utf8'),
    ) as { dependencies: Record<string, string> };
    expect(runtime.dependencies).toEqual({
      '@google-cloud/firestore': '9.3.1',
      unpdf: '1.9.1',
    });

    const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
    const runtimeImporter = lock
      .split('  apps/agent/runtime-dependencies:\n')[1]
      ?.split('\n  apps/')[0];
    expect(runtimeImporter).toContain(`    dependencies:
      '@google-cloud/firestore':
        specifier: 9.3.1
        version: 9.3.1
      unpdf:
        specifier: 1.9.1
        version: 1.9.1`);

    const coreImporter = lock.split('  packages/core:\n')[1]?.split('\n  packages/')[0];
    expect(coreImporter).toContain(`      unpdf:
        specifier: ^1.9.1
        version: 1.9.1`);
  });

  it('ships the pnpm closure and leaves runtime JavaScript in the image scan', () => {
    const dockerfile = readFileSync(resolve(root, 'infra/docker/agent.Dockerfile'), 'utf8');
    expect(dockerfile).toContain(
      'pnpm --filter @assistant/agent-runtime-dependencies --prod deploy --legacy /runtime-dependencies',
    );
    expect(dockerfile).toContain(
      'COPY --from=build --chown=node:node /runtime-dependencies/node_modules ./node_modules',
    );
    expect(dockerfile).not.toMatch(/npm install .*unpdf|@google-cloud\/firestore/);

    const workflow = readFileSync(resolve(root, '.github/workflows/deploy.yml'), 'utf8');
    expect(workflow).not.toContain('TRIVY_SKIP_DIRS');
    expect(workflow).toContain('aquasecurity/trivy-action');
  });
});
