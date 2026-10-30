// Proposal only: add an isolated fixture case to runtime-support-matrix.test.mjs.
// Keep the production generator unchanged; it already derives the journal ordinal
// and compatibility booleans from the source contract.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRuntimeSupportSnapshot } from './runtime-support-matrix.mjs';

let root;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe('PostgreSQL schema 133 release support fixture', () => {
  it('marks the exact PostgreSQL 133 target and selected workers compatible', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'assistant-support-schema-133-'));
    const sources = [
      'packages/config/src/index.ts',
      'apps/agent/src/deps.ts',
      'apps/agent/src/index.ts',
      'apps/web/lib/server.ts',
      'apps/web/proxy.ts',
    ];
    for (const relative of sources) {
      const full = path.join(root, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, 'export {}\n');
    }
    const journalPath = path.join(root, 'packages/db/drizzle/meta/_journal.json');
    await mkdir(path.dirname(journalPath), { recursive: true });
    await writeFile(journalPath, JSON.stringify({ entries: [{ idx: 133, tag: '0133_fixture' }] }));
    const contract = JSON.parse(
      await readFile(new URL('../infra/gcp/release-contracts.json', import.meta.url), 'utf8'),
    );
    const contractPath = path.join(root, 'infra/gcp/release-contracts.json');
    await mkdir(path.dirname(contractPath), { recursive: true });
    await writeFile(contractPath, JSON.stringify(contract));

    const snapshot = await buildRuntimeSupportSnapshot(root);
    expect(snapshot.postgresSchemaVersion).toBe(133);
    expect(snapshot.agentWebSchemaCompatible).toBe(true);
    for (const name of ['agent', 'web', 'browser', 'code', 'processor']) {
      expect(snapshot.releaseContracts[name].currentPostgresSchemaCompatible).toBe(true);
    }
  });
});
