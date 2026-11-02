import { describe, expect, it } from 'vitest';
import {
  checksum,
  type MigrationBundle,
  type MigrationRecord,
  migrationBundleChecksum,
  type SerializedValue,
  serializeMigrationValue,
  validateMigrationBundle,
} from './migration.js';
import type { OwnerEditorCommand, OwnerEditorOperationRecord } from './owner-editor.js';
import {
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
} from './owner-editor-identity.js';
import { parseOwnerEditorOperationRecord } from './owner-editor-storage.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const epoch = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const targetId = '44444444-4444-4444-8444-444444444444';
const memoryId = '55555555-5555-4555-8555-555555555555';
const relationId = '77777777-7777-4777-8777-777777777777';
const assertionId = '88888888-8888-4888-8888-888888888888';
const oldCommands = [
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
] as const satisfies readonly OwnerEditorCommand[];

function savedIds(command: OwnerEditorCommand) {
  switch (command) {
    case 'create_person':
    case 'update_person_identity':
      return { contactId: targetId };
    case 'add_family_relationship':
    case 'correct_owner_family_relationship':
      return { relationId, memoryId, assertionId };
    case 'correct_owner_memory':
    case 'create_owner_memory':
      return { memoryId };
    default:
      throw new Error(`Unexpected persisted command: ${command}`);
  }
}

function committedRecord(command: OwnerEditorCommand): OwnerEditorOperationRecord {
  const now = new Date('2026-10-25T12:00:00.000Z');
  const scope = {
    ownerId,
    sessionDigest: 'a'.repeat(64),
    epoch,
    privacyGeneration: null,
    command,
    operationId,
    targetId: command === 'create_person' ? null : targetId,
    nonce: '66666666-6666-4666-8666-666666666666',
    issuedAt: now.getTime(),
    expiresAt: now.getTime() + 600_000,
  };
  return {
    id: ownerEditorOperationId(scope),
    ownerId,
    epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(null),
    operationId,
    requestHash: 'b'.repeat(64),
    scopeDigest: ownerEditorScopeDigest(scope),
    command,
    protocolVersion: 1,
    formIssuedAt: now,
    formExpiresAt: new Date(now.getTime() + 600_000),
    claimToken: null,
    claimExpiresAt: null,
    status: 'committed',
    statusVersion: 2,
    result: { outcome: 'saved', ids: savedIds(command), revision: 'c'.repeat(64) },
    createdAt: now,
    updatedAt: now,
  };
}

function portableBundleWithOwnerEditorReceipt(): MigrationBundle {
  const agentData = {
    id: ownerId,
    name: 'Owner',
    email: 'owner@example.test',
    workspacePrefix: 'workspace/test',
  };
  const agentRecord: MigrationRecord = {
    table: 'agents',
    collection: 'agents',
    id: ownerId,
    data: agentData,
    checksum: checksum(agentData),
  };
  const rawReceipt = committedRecord('create_owner_memory');
  const receiptData = serializeMigrationValue(rawReceipt) as Record<string, SerializedValue>;
  const receiptRecord = {
    table: 'owner_editor_operations',
    collection: 'ownerEditorOperations',
    id: rawReceipt.id,
    data: receiptData,
    checksum: checksum(receiptData),
  } as unknown as MigrationRecord;
  const records = [agentRecord, receiptRecord];
  return {
    manifest: {
      format: 'assistant-workspace-migration',
      formatVersion: 1,
      mode: 'export',
      source: {
        kind: 'postgresql',
        agentId: ownerId,
        scope: 'installation',
        snapshot: '1:1:',
      },
      target: {
        projectId: 'customer-project',
        databaseId: '(default)',
        installationId: 'assistant',
      },
      coverage: { complete: false, supportedTables: ['agents'], omittedTables: ['tasks'] },
      tables: {
        agents: { collection: 'agents', count: 1, checksum: checksum([agentRecord]) },
      } as MigrationBundle['manifest']['tables'],
      recordCount: records.length,
      bundleChecksum: migrationBundleChecksum(records, 1),
      unsupportedTables: [],
    },
    records,
  };
}

describe('create-owner-memory retained receipt compatibility', () => {
  it.each([...oldCommands, 'create_owner_memory' as const])(
    'recognizes a valid saved receipt for %s',
    (command) => {
      const ids = savedIds(command);
      expect(parseOwnerEditorOperationRecord(committedRecord(command))).toMatchObject({
        command,
        result: { outcome: 'saved', ids },
      });
    },
  );

  it('keeps the create-note receipt identity memory-only', () => {
    for (const ids of [{ contactId: targetId }, { memoryId, relationId: targetId }, {}]) {
      expect(() =>
        parseOwnerEditorOperationRecord({
          ...committedRecord('create_owner_memory'),
          result: { outcome: 'saved', ids, revision: 'c'.repeat(64) },
        }),
      ).toThrow();
    }
  });

  it('keeps new-command receipts outside portable import and replay', () => {
    const bundle = portableBundleWithOwnerEditorReceipt();
    // The validator rejects the runtime table before considering receipt contents for replay.
    expect(() =>
      validateMigrationBundle(bundle, {
        sourceAgentId: ownerId,
        target: bundle.manifest.target,
      }),
    ).toThrow('Owner editor runtime metadata cannot be imported');
  });
});
