import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntimeSupportSnapshot } from './runtime-support-matrix.mjs';

let root;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('runtime support source snapshot', () => {
  it('records effective exported route methods and runtime composition digests', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'assistant-support-matrix-'));
    const files = {
      'apps/web/app/api/chat/route.ts':
        'export async function GET() { return Response.json({ ok: true }); }\nexport const POST = handler;\n',
      'packages/config/src/index.ts': 'export const drivers = ["postgres", "firestore"];\n',
      'apps/agent/src/deps.ts': 'export function buildDeps() {}\n',
      'apps/agent/src/index.ts': 'startPoller(deps);\n',
      'apps/web/lib/server.ts': 'export const persistence = "postgres";\n',
      'apps/web/proxy.ts': 'export function proxy() {}\n',
      'packages/db/drizzle/meta/_journal.json': '{"entries":[{"idx":3,"tag":"0003_fixture"}]}\n',
      'infra/gcp/release-contracts.json':
        '{"components":{"agent":{"apiContract":2,"peerApi":{"min":1,"max":2},"schema":{"postgres":{"min":3,"max":4}}},"web":{"apiContract":2,"peerApi":{"min":1,"max":2},"schema":{"postgres":{"min":3,"max":4}}}}}\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }

    const snapshot = await buildRuntimeSupportSnapshot(root);
    expect(snapshot.webApiRouteCount).toBe(1);
    expect(snapshot.routes['apps/web/app/api/chat/route.ts']?.methods).toEqual(['GET', 'POST']);
    expect(snapshot.runtimeSources['apps/agent/src/index.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot).toMatchObject({
      latestPostgresMigration: '0003_fixture',
      postgresSchemaVersion: 3,
      agentWebSchemaCompatible: true,
    });
  });

  it('makes a newly added route observable in the generated inventory', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'assistant-support-matrix-'));
    const files = [
      'packages/config/src/index.ts',
      'apps/agent/src/deps.ts',
      'apps/agent/src/index.ts',
      'apps/web/lib/server.ts',
      'apps/web/proxy.ts',
      'packages/db/drizzle/meta/_journal.json',
      'infra/gcp/release-contracts.json',
    ];
    for (const relative of files) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      if (relative.endsWith('_journal.json'))
        await writeFile(full, '{"entries":[{"idx":3,"tag":"0003_fixture"}]}\n');
      else if (relative.endsWith('release-contracts.json'))
        await writeFile(
          full,
          '{"components":{"agent":{"schema":{"postgres":{"min":3,"max":4}}},"web":{"schema":{"postgres":{"min":3,"max":4}}}}}\n',
        );
      else await writeFile(full, 'export {};\n');
    }
    const route = path.join(root, 'apps/web/app/api/new/route.ts');
    await mkdir(path.dirname(route), { recursive: true });
    await writeFile(route, 'export function DELETE() {}\n');

    const snapshot = await buildRuntimeSupportSnapshot(root);
    expect(snapshot.routes['apps/web/app/api/new/route.ts']?.methods).toEqual(['DELETE']);
  });

  it('marks the source contract incompatible when the schema exceeds the reviewed range', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'assistant-support-matrix-'));
    const files = [
      'packages/config/src/index.ts',
      'apps/agent/src/deps.ts',
      'apps/agent/src/index.ts',
      'apps/web/lib/server.ts',
      'apps/web/proxy.ts',
    ];
    for (const relative of files) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, 'export {};\n');
    }
    const journal = path.join(root, 'packages/db/drizzle/meta/_journal.json');
    await mkdir(path.dirname(journal), { recursive: true });
    await writeFile(journal, '{"entries":[{"idx":5,"tag":"0005_fixture"}]}\n');
    const contract = path.join(root, 'infra/gcp/release-contracts.json');
    await mkdir(path.dirname(contract), { recursive: true });
    await writeFile(
      contract,
      '{"components":{"agent":{"schema":{"postgres":{"min":3,"max":4}}},"web":{"schema":{"postgres":{"min":3,"max":4}}}}}\n',
    );

    expect(await buildRuntimeSupportSnapshot(root)).toMatchObject({
      postgresSchemaVersion: 5,
      agentWebSchemaCompatible: false,
    });
  });
});
