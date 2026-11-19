import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { type MigrationBundle, validateMigrationBundle } from '@assistant/persistence';
import { Firestore } from '@google-cloud/firestore';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallationStore } from './store.js';
import { importWorkspaceBundle } from './workspace-migration.js';

const emulatorEnabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const handoffPath = process.env.ASSISTANT_MEMORY_WITNESS_COMPAT_BUNDLE_PATH;
const handoffDirectory = process.env.ASSISTANT_MEMORY_WITNESS_COMPAT_HANDOFF_DIR;
const handoffEnabled = Boolean(handoffPath && handoffDirectory);
const installationId = process.env.ASSISTANT_MEMORY_WITNESS_COMPAT_INSTALLATION_ID;
const claimNonce = process.env.ASSISTANT_MEMORY_WITNESS_COMPAT_CLAIM_NONCE;
const target = {
  projectId: 'demo-assistant-test',
  databaseId: '(default)',
  installationId: installationId ?? '',
};

describe.skipIf(!emulatorEnabled || !handoffEnabled)(
  'PostgreSQL 0135 portable memory witness compatibility',
  () => {
    let store: InstallationStore | undefined;

    afterEach(async () => {
      if (!store) return;
      const currentStore = store;
      store = undefined;
      const cleanupErrors: unknown[] = [];
      try {
        const root = await currentStore.root.get();
        const claim = root.get('memoryWitnessCompatibilityClaim') as
          | Record<string, unknown>
          | undefined;
        if (root.exists) {
          if (
            claim?.kind !== 'memory-witness-firestore-compat' ||
            claim.installationId !== target.installationId ||
            claim.nonce !== claimNonce
          )
            throw new Error('Refusing to delete an installation without its exact claim nonce.');
          await currentStore.db.recursiveDelete(currentStore.root);
          const afterDelete = await currentStore.root.get();
          if (afterDelete.exists)
            throw new Error('Claimed Firestore installation remains after cleanup.');
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await currentStore.db.terminate();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length)
        throw new AggregateError(cleanupErrors, 'Claimed Firestore installation cleanup failed.');
    });

    it('imports the exact private PostgreSQL export bytes without installation-local witness data', async () => {
      if (!handoffPath || !handoffDirectory)
        throw new Error('Exact PostgreSQL bundle handoff is required for this test.');
      if (
        !installationId ||
        !/^memory-witness-[0-9a-f-]{36}$/.test(installationId) ||
        !claimNonce ||
        !/^[0-9a-f]{32}$/.test(claimNonce)
      )
        throw new Error('A fresh caller-owned Firestore installation claim is required.');
      const privateDirectory = resolve(handoffDirectory);
      const resolvedHandoffPath = resolve(handoffPath);
      const directoryStat = await lstat(privateDirectory);
      const bundleStat = await lstat(resolvedHandoffPath);
      if (
        !directoryStat.isDirectory() ||
        directoryStat.isSymbolicLink() ||
        (directoryStat.mode & 0o777) !== 0o700 ||
        dirname(resolvedHandoffPath) !== privateDirectory ||
        !resolvedHandoffPath.endsWith('/postgres-export.bundle.json') ||
        !bundleStat.isFile() ||
        bundleStat.isSymbolicLink() ||
        (bundleStat.mode & 0o777) !== 0o600 ||
        bundleStat.size === 0 ||
        bundleStat.size > 8 * 1024 * 1024
      )
        throw new Error('PostgreSQL bundle handoff is not a bounded private regular file.');

      const bytes = await readFile(resolvedHandoffPath);
      const actualBundleSha256 = createHash('sha256').update(bytes).digest('hex');
      const expectedBundleSha256 = process.env.ASSISTANT_MEMORY_WITNESS_COMPAT_BUNDLE_SHA256;
      if (!expectedBundleSha256 || actualBundleSha256 !== expectedBundleSha256)
        throw new Error('PostgreSQL bundle bytes do not match the export-phase handoff hash.');
      const bundle = JSON.parse(bytes.toString('utf8')) as MigrationBundle;
      const sourceAgentId = bundle.manifest.source.agentId;
      validateMigrationBundle(bundle, { sourceAgentId, target });
      expect(bundle.manifest.source.kind).toBe('postgresql');
      expect(bundle.manifest.target).toEqual(target);

      const legacy = bundle.records.find(
        (record) =>
          record.table === 'memories' &&
          record.data.content === 'Legacy owner corrected note at migration 0134',
      );
      expect(legacy).toBeDefined();
      if (!legacy) throw new Error('Populated PostgreSQL export is missing its legacy memory.');
      expect(legacy.data).toMatchObject({
        agentId: sourceAgentId,
        contentHash: createHash('sha256')
          .update('Legacy owner corrected note at migration 0134')
          .digest('hex'),
        ownerConfirmed: true,
        pinned: true,
        originTrust: 'owner',
        ownerCorrection: {
          version: 1,
          correctedByOwner: true,
          currentContentHash: legacy.data.contentHash,
        },
      });
      expect(Object.hasOwn(legacy.data, 'memoryWriteWitness')).toBe(false);
      expect(Object.hasOwn(legacy.data, 'memory_write_witness')).toBe(false);

      store = new InstallationStore(
        new Firestore({ projectId: target.projectId, databaseId: target.databaseId }),
        target.installationId,
        undefined,
        target.projectId,
        target.databaseId,
      );
      const preexistingRoot = await store.root.get();
      if (preexistingRoot.exists)
        throw new Error('Fresh Firestore installation root already exists; refusing to claim it.');
      await store.root.create({
        memoryWitnessCompatibilityClaim: {
          kind: 'memory-witness-firestore-compat',
          installationId,
          nonce: claimNonce,
        },
      });
      const claimedRoot = await store.root.get();
      const claimedMarker = claimedRoot.get('memoryWitnessCompatibilityClaim') as
        | Record<string, unknown>
        | undefined;
      if (
        !claimedRoot.exists ||
        claimedMarker?.kind !== 'memory-witness-firestore-compat' ||
        claimedMarker.installationId !== installationId ||
        claimedMarker.nonce !== claimNonce
      )
        throw new Error('Firestore installation nonce claim was not retained exactly.');
      const result = await importWorkspaceBundle(store, bundle, {
        sourceAgentId,
        target,
        mode: 'write',
      });
      expect(result).toMatchObject({
        mode: 'write',
        verified: true,
        destinationOwnerChecked: true,
      });

      const importedMemory = await store.doc('memories', legacy.id).get();
      expect(importedMemory.exists).toBe(true);
      const importedMemoryData = importedMemory.data() ?? {};
      expect(importedMemoryData).toMatchObject({
        id: legacy.id,
        agentId: sourceAgentId,
        content: 'Legacy owner corrected note at migration 0134',
        contentHash: legacy.data.contentHash,
        ownerConfirmed: true,
        pinned: true,
        originTrust: 'owner',
        ownerCorrection: legacy.data.ownerCorrection,
      });
      expect(Object.hasOwn(importedMemoryData, 'memoryWriteWitness')).toBe(false);
      expect(Object.hasOwn(importedMemoryData, 'memory_write_witness')).toBe(false);
      expect((await store.doc('coordination', 'migration').get()).get('status')).toBe(
        'pending_activation',
      );
    });
  },
);
