import type {
  OwnerEditorClaim,
  OwnerEditorCommand,
  OwnerEditorOperationRecord,
  OwnerEditorReceiptProof,
  OwnerEditorScope,
} from './owner-editor.js';
import {
  ownerEditorOperationId,
  ownerEditorPrivacyDigest,
  ownerEditorScopeDigest,
  ownerEditorSnapshotRevision,
} from './owner-editor-identity.js';

export type OwnerEditorReaderCommand =
  | 'create_person'
  | 'update_person_identity'
  | 'add_family_relationship'
  | 'correct_owner_family_relationship'
  | 'correct_owner_memory';

export interface OwnerEditorReaderFixture {
  scope: OwnerEditorScope;
  record: OwnerEditorOperationRecord;
}

export interface OwnerEditorPreparingReaderFixture extends OwnerEditorReaderFixture {
  claim: OwnerEditorClaim;
  proof: OwnerEditorReceiptProof;
}

export interface OwnerEditorReaderFixtureSet {
  oldSaved: readonly OwnerEditorReaderFixture[];
  createOwnerMemory: {
    preparing: OwnerEditorPreparingReaderFixture;
    expiredPreparing: OwnerEditorPreparingReaderFixture;
    savedRefresh: OwnerEditorReaderFixture;
    savedNoRefresh: OwnerEditorReaderFixture;
    conflict: OwnerEditorReaderFixture;
    invalid: OwnerEditorReaderFixture;
    unavailable: OwnerEditorReaderFixture;
    notApplied: readonly [OwnerEditorReaderFixture, OwnerEditorReaderFixture];
  };
}

export interface OwnerEditorReaderFixtureInput {
  ownerId: string;
  epoch: string;
  now: Date;
  privacyGeneration: string | null;
}

const ids = {
  oldCreatePerson: '10000000-0000-4000-8000-000000000001',
  oldUpdatePerson: '10000000-0000-4000-8000-000000000002',
  oldAddFamily: '10000000-0000-4000-8000-000000000003',
  oldCorrectFamily: '10000000-0000-4000-8000-000000000004',
  oldCorrectMemory: '10000000-0000-4000-8000-000000000005',
  createPreparing: '10000000-0000-4000-8000-000000000006',
  createExpiredPreparing: '10000000-0000-4000-8000-000000000007',
  createSavedRefresh: '10000000-0000-4000-8000-000000000008',
  createSavedNoRefresh: '10000000-0000-4000-8000-000000000009',
  createConflict: '10000000-0000-4000-8000-000000000010',
  createInvalid: '10000000-0000-4000-8000-000000000011',
  createUnavailable: '10000000-0000-4000-8000-000000000012',
  createNotAppliedAbandoned: '10000000-0000-4000-8000-000000000013',
  createNotAppliedPreparationFailed: '10000000-0000-4000-8000-000000000014',
  subject: '20000000-0000-4000-8000-000000000001',
  relation: '30000000-0000-4000-8000-000000000001',
  memory: '40000000-0000-4000-8000-000000000001',
  assertion: '50000000-0000-4000-8000-000000000001',
} as const;

const savedCommands: readonly OwnerEditorReaderCommand[] = [
  'create_person',
  'update_person_identity',
  'add_family_relationship',
  'correct_owner_family_relationship',
  'correct_owner_memory',
];

function dateAt(now: Date, offsetMs: number): Date {
  const value = new Date(now.getTime() + offsetMs);
  if (!Number.isFinite(value.getTime())) throw new Error('Reader fixture clock is invalid');
  return value;
}

function savedIds(command: OwnerEditorCommand) {
  switch (command) {
    case 'create_person':
    case 'update_person_identity':
      return { contactId: ids.subject };
    case 'add_family_relationship':
    case 'correct_owner_family_relationship':
      return { relationId: ids.relation, memoryId: ids.memory, assertionId: ids.assertion };
    case 'correct_owner_memory':
    case 'create_owner_memory':
      return { memoryId: ids.memory };
    default:
      throw new Error(`Unsupported reader fixture command: ${command}`);
  }
}

function buildScope(
  input: OwnerEditorReaderFixtureInput,
  command: OwnerEditorCommand,
  operationId: string,
  targetId: string | null,
): OwnerEditorScope {
  const issuedAt = dateAt(input.now, -1_000).getTime();
  return {
    ownerId: input.ownerId,
    sessionDigest: 'a'.repeat(64),
    epoch: input.epoch,
    privacyGeneration: input.privacyGeneration,
    command,
    operationId,
    targetId,
    nonce: '60000000-0000-4000-8000-000000000001',
    issuedAt,
    expiresAt: issuedAt + 600_000,
  };
}

function buildRecord(
  input: OwnerEditorReaderFixtureInput,
  scope: OwnerEditorScope,
  state: {
    status: OwnerEditorOperationRecord['status'];
    statusVersion: number;
    result: OwnerEditorOperationRecord['result'];
    claimToken?: string;
    claimExpiresAt?: Date;
  },
): OwnerEditorOperationRecord {
  const formIssuedAt = dateAt(input.now, -1_000);
  const formExpiresAt = new Date(scope.expiresAt);
  return {
    id: ownerEditorOperationId(scope),
    ownerId: input.ownerId,
    epoch: input.epoch,
    privacyGenerationDigest: ownerEditorPrivacyDigest(input.privacyGeneration),
    operationId: scope.operationId,
    requestHash: 'b'.repeat(64),
    scopeDigest: ownerEditorScopeDigest(scope),
    command: scope.command,
    protocolVersion: 1,
    formIssuedAt,
    formExpiresAt,
    claimToken: state.claimToken ?? null,
    claimExpiresAt: state.claimExpiresAt ? new Date(state.claimExpiresAt.getTime()) : null,
    status: state.status,
    statusVersion: state.statusVersion,
    result: state.result,
    createdAt: dateAt(input.now, -900),
    updatedAt: dateAt(input.now, -800),
  };
}

function savedResult(command: OwnerEditorCommand, refreshPending?: boolean) {
  return {
    outcome: 'saved' as const,
    ids: savedIds(command),
    revision: 'c'.repeat(64),
    ...(refreshPending === undefined ? {} : { refreshPending }),
  };
}

function terminalFixture(
  input: OwnerEditorReaderFixtureInput,
  operationId: string,
  result: NonNullable<OwnerEditorOperationRecord['result']>,
): OwnerEditorReaderFixture {
  const scope = buildScope(input, 'create_owner_memory', operationId, ids.subject);
  return {
    scope,
    record: buildRecord(input, scope, {
      status:
        result.outcome === 'saved' || result.outcome === 'unchanged'
          ? 'committed'
          : result.outcome === 'not_applied'
            ? 'abandoned'
            : 'terminal_rejected',
      statusVersion: 2,
      result,
    }),
  };
}

function preparingFixture(
  input: OwnerEditorReaderFixtureInput,
  operationId: string,
  claimExpiresOffsetMs: number,
): OwnerEditorPreparingReaderFixture {
  const scope = buildScope(input, 'create_owner_memory', operationId, ids.subject);
  const claimExpiresAt = dateAt(input.now, claimExpiresOffsetMs);
  const record = buildRecord(input, scope, {
    status: 'preparing',
    statusVersion: 1,
    result: null,
    claimToken: '70000000-0000-4000-8000-000000000001',
    claimExpiresAt,
  });
  const claim: OwnerEditorClaim = {
    scope,
    requestHash: record.requestHash,
    claimToken: record.claimToken ?? '70000000-0000-4000-8000-000000000001',
    claimExpiresAt: new Date(claimExpiresAt.getTime()),
    statusVersion: record.statusVersion,
  };
  return {
    scope,
    record,
    claim,
    proof: {
      scope,
      requestHash: record.requestHash,
      claimIdentityDigest: ownerEditorSnapshotRevision({
        token: claim.claimToken,
        expiresAt: claim.claimExpiresAt.toISOString(),
      }),
      statusVersion: record.statusVersion,
      issuedAt: input.now.getTime(),
      expiresAt: dateAt(input.now, 120_000).getTime(),
    },
  };
}

export function readerFixtures(input: OwnerEditorReaderFixtureInput): OwnerEditorReaderFixtureSet {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()))
    throw new Error('Reader fixture clock must be a valid Date');

  const oldSaved = savedCommands.map((command, index) => {
    const operationId = Object.values(ids)[index];
    if (!operationId) throw new Error('Missing stable reader operation ID');
    const targetId = command === 'create_person' ? null : ids.subject;
    const scope = buildScope(input, command, operationId, targetId);
    return {
      scope,
      record: buildRecord(input, scope, {
        status: 'committed',
        statusVersion: 2,
        result: savedResult(command),
      }),
    };
  });

  const createOwnerMemory = {
    preparing: preparingFixture(input, ids.createPreparing, 60_000),
    expiredPreparing: preparingFixture(input, ids.createExpiredPreparing, -1),
    savedRefresh: terminalFixture(
      input,
      ids.createSavedRefresh,
      savedResult('create_owner_memory', true),
    ),
    savedNoRefresh: terminalFixture(
      input,
      ids.createSavedNoRefresh,
      savedResult('create_owner_memory', false),
    ),
    conflict: terminalFixture(input, ids.createConflict, {
      outcome: 'conflict',
      reason: 'memory_subject_changed',
    }),
    invalid: terminalFixture(input, ids.createInvalid, {
      outcome: 'invalid',
      fieldErrors: { content: 'Invalid content' },
    }),
    unavailable: terminalFixture(input, ids.createUnavailable, {
      outcome: 'unavailable',
      reason: 'editor_command_unavailable',
    }),
    notApplied: [
      terminalFixture(input, ids.createNotAppliedAbandoned, {
        outcome: 'not_applied',
        reason: 'claim_abandoned',
      }),
      terminalFixture(input, ids.createNotAppliedPreparationFailed, {
        outcome: 'not_applied',
        reason: 'preparation_failed',
      }),
    ] as const,
  };

  return { oldSaved, createOwnerMemory };
}

/** Explicit malformed decode cases. Date fields remain actual Date objects unless invalidated. */
export function invalidCreateOwnerMemoryReaderRecords(
  fixture: OwnerEditorReaderFixture,
): Readonly<Record<string, unknown>> {
  const { record } = fixture;
  if (record.command !== 'create_owner_memory' || record.result?.outcome !== 'saved')
    throw new Error('A saved create-owner-memory reader fixture is required');
  const savedResult = record.result;
  const clone = (): OwnerEditorOperationRecord => ({
    ...record,
    formIssuedAt: new Date(record.formIssuedAt.getTime()),
    formExpiresAt: new Date(record.formExpiresAt.getTime()),
    claimExpiresAt: record.claimExpiresAt ? new Date(record.claimExpiresAt.getTime()) : null,
    createdAt: new Date(record.createdAt.getTime()),
    updatedAt: new Date(record.updatedAt.getTime()),
    result: { ...savedResult, ids: { ...savedResult.ids } },
  });
  const unchanged = clone();
  if (unchanged.result?.outcome !== 'saved') throw new Error('Saved fixture changed shape');
  unchanged.result = { ...unchanged.result, outcome: 'unchanged' };

  const extraIds = clone();
  if (extraIds.result?.outcome !== 'saved') throw new Error('Saved fixture changed shape');
  extraIds.result = {
    ...extraIds.result,
    ids: { ...extraIds.result.ids, contactId: ids.subject },
  };

  const wrongState = clone();
  wrongState.status = 'preparing';

  const stringDate = clone();
  const malformedDate: Record<string, unknown> = {
    ...stringDate,
    formIssuedAt: stringDate.formIssuedAt.toISOString(),
  };

  const invalidDate = clone();
  invalidDate.createdAt = new Date(Number.NaN);

  return {
    unchanged,
    extraIds,
    wrongState,
    stringDate: malformedDate,
    invalidDate,
  };
}
