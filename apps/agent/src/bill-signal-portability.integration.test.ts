import { randomUUID } from 'node:crypto';
import {
  assertPostgresInstallationOwner,
  createPostgresSignalRepository,
  emailIngest,
} from '@assistant/db';
import { exportWorkspaceSnapshot } from '@assistant/db/workspace-migration';
import { createFirestoreSignalRepository } from '@assistant/firestore';
import { importWorkspaceBundle } from '@assistant/firestore/workspace-migration';
import { validateMigrationReferences } from '@assistant/persistence';
import { expect, it } from 'vitest';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';
import { emailIngestFixture } from '../../../packages/persistence/src/signal-test-scenarios.js';
import { createIsolatedTestDatabase } from './isolated-test-database.fixture.js';

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'keeps a paid bill, its sources and its historical validity through workspace transfer',
  async () => {
    const source = await createIsolatedTestDatabase();
    const destination = emulatorStore();
    try {
      const agentId = await assertPostgresInstallationOwner(source.db);
      const issued = new Date('2026-11-19T12:00:00Z');
      const paid = new Date('2026-11-20T12:00:00Z');
      const invoice = emailIngestFixture(
        agentId,
        'Invoice SYN-317: USD 42.15 is due on November 23, 2026.',
        issued,
      );
      const receipt = emailIngestFixture(
        agentId,
        'Payment received in full for invoice SYN-317: USD 42.15. Balance due: USD 0.00.',
        paid,
      );
      await source.db.insert(emailIngest).values([invoice, receipt]);
      const pg = createPostgresSignalRepository(source.db);
      const bill = await pg.record({
        agentId,
        emailIngestId: invoice.id,
        subjectPersonIds: ['owner'],
        at: issued,
      });
      const payment = await pg.record({
        agentId,
        emailIngestId: receipt.id,
        subjectPersonIds: ['owner'],
        at: paid,
        replaces: bill.id,
      });
      const target = {
        projectId: 'demo-assistant-test',
        databaseId: '(default)',
        installationId: destination.installationId,
      };
      const bundle = await exportWorkspaceSnapshot({
        agentId,
        databaseUrl: source.databaseUrl,
        target,
      });
      expect(bundle.manifest.coverage.complete).toBe(true);
      expect(bundle.manifest.tables.signals.count).toBe(2);
      const wrongOwner = bundle.records.map((row) =>
        row.table === 'signals' && row.id === payment.id
          ? { ...row, data: { ...row.data, record: { ...payment, agentId: randomUUID() } } }
          : row,
      );
      expect(() => validateMigrationReferences(wrongOwner, agentId)).toThrow(
        'Invalid signal migration',
      );
      const result = await importWorkspaceBundle(destination, bundle, {
        sourceAgentId: agentId,
        target,
        mode: 'write',
      });
      expect(result.verified).toBe(true);
      const fs = createFirestoreSignalRepository(destination);
      const closed = { ...bill, validTo: paid.toISOString(), supersededBy: payment.id };
      expect(await fs.get(agentId, bill.id)).toEqual(closed);
      expect(await fs.list({ agentId, kind: 'bill', asOf: issued })).toEqual([closed]);
      expect(await fs.list({ agentId, kind: 'bill', asOf: paid })).toEqual([]);
      expect(await fs.list({ agentId, personId: 'owner', asOf: paid })).toEqual([payment]);
      expect(closed.sourceRefs[0].id).toBe(invoice.admittedSourceId);
      expect(payment.sourceRefs[0].id).toBe(receipt.admittedSourceId);
      expect(await fs.get(randomUUID(), payment.id)).toBeNull();
    } finally {
      try {
        await disposeStore(destination);
      } finally {
        await source.close();
      }
    }
  },
  60_000,
);
