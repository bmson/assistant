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
      '@google-cloud/firestore': '9.2.0',
      unpdf: '1.8.1',
    });

    const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toContain('apps/agent/runtime-dependencies:');
    expect(lock).toContain('specifier: 9.2.0\n        version: 9.2.0');
    expect(lock).toContain('specifier: 1.8.1\n        version: 1.8.1');
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
