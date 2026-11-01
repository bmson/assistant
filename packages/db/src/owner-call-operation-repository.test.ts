import { describe, expect, it, vi } from 'vitest';
import type { Db } from './client.js';
import {
  commitOwnerCallGrantOperationInTransaction,
  discoverOwnerCallGrantOperation,
  OwnerCallGrantOperationRollbackError,
  readOwnerCallGrantOperationCheck,
  registerOwnerCallGrantOperation,
} from './owner-call-operation-repository.js';
import { ownerCallGrantOperationSlots, ownerCallGrantOperations } from './schema.js';

const ownerId = '00000000-0000-4000-8000-000000000001';
const approvalId = '00000000-0000-4000-8000-000000000002';
const oldGrantId = '00000000-0000-4000-8000-000000000003';
const newGrantId = '00000000-0000-4000-8000-000000000004';
const taskId = '00000000-0000-4000-8000-000000000005';
const toolCallId = '00000000-0000-4000-8000-000000000006';
const now = new Date('2026-10-26T12:00:00.000Z');

function fakeDb() {
  const slot = {
    purpose: 'owner-call-grant-operation.v1',
    schemaVersion: 1,
    ownerId,
    approvalId,
    generation: 1,
    currentGrantId: oldGrantId,
    updatedAt: now,
  };
  const oldOperation = {
    purpose: 'owner-call-grant-operation.v1',
    schemaVersion: 1,
    operationVersion: 1,
    ownerId,
    approvalId,
    grantId: oldGrantId,
    taskId,
    toolCallId,
    slotGeneration: 1,
    requestFingerprint: 'a'.repeat(64),
    grantScopeFingerprint: 'b'.repeat(64),
    phase: 'registered',
    registeredAt: now,
    reviewExpiresAt: new Date(now.getTime() + 60_000),
    grantExpiresAt: new Date(now.getTime() + 86_400_000),
    admittedAt: null,
    committedAt: null,
    closedAt: null,
    rejectedAt: null,
    createdPolicyId: null,
    wakeGeneration: null,
    updatedAt: now,
  };
  let state = { slot, operation: oldOperation };
  const tx = {
    async execute() {
      return [{ now }];
    },
    insert(table: unknown) {
      let value: Record<string, unknown> | undefined;
      const query = {
        values(next: Record<string, unknown>) {
          value = next;
          return query;
        },
        onConflictDoNothing() {
          if (table === ownerCallGrantOperationSlots && !state.slot) {
            state = { ...state, slot: value } as typeof state;
          }
          return query;
        },
        returning() {
          return Promise.resolve(table === ownerCallGrantOperations ? [] : value ? [value] : []);
        },
      };
      return query;
    },
    select() {
      let table: unknown;
      return {
        from(value: unknown) {
          table = value;
          return {
            where() {
              const selected = {
                for: () => selected,
                limit: async () => [
                  table === ownerCallGrantOperationSlots ? state.slot : state.operation,
                ],
              };
              return selected;
            },
          };
        },
      };
    },
    update(table: unknown) {
      let changes: Record<string, unknown> = {};
      return {
        set(value: Record<string, unknown>) {
          changes = value;
          return {
            where() {
              return {
                returning: async () => {
                  if (table === ownerCallGrantOperations) {
                    state = { ...state, operation: { ...state.operation, ...changes } };
                    return [state.operation];
                  }
                  state = { ...state, slot: { ...state.slot, ...changes } };
                  return [state.slot];
                },
              };
            },
          };
        },
      };
    },
  };
  const db = {
    async transaction<T>(body: (transaction: typeof tx) => Promise<T>) {
      const before = state;
      const working = structuredClone(before);
      state = working;
      try {
        const result = await body(tx);
        return result;
      } catch (error) {
        state = before;
        throw error;
      }
    },
  };
  return {
    db: db as unknown as Db,
    state: () => state,
  };
}

describe('PostgreSQL owner-call operation repository', () => {
  it('discovers only the exact current slot and fails closed on a dangling pointer', async () => {
    const operation = {
      purpose: 'owner-call-grant-operation.v1',
      schemaVersion: 1,
      operationVersion: 1,
      ownerId,
      approvalId,
      grantId: oldGrantId,
      taskId,
      toolCallId,
      slotGeneration: 1,
      requestFingerprint: 'a'.repeat(64),
      grantScopeFingerprint: 'b'.repeat(64),
      phase: 'registered',
      registeredAt: now,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
      admittedAt: null,
      committedAt: null,
      closedAt: null,
      rejectedAt: null,
      createdPolicyId: null,
      wakeGeneration: null,
      updatedAt: now,
    };
    const slot = {
      purpose: 'owner-call-grant-operation.v1',
      schemaVersion: 1,
      ownerId,
      approvalId,
      generation: 1,
      currentGrantId: oldGrantId,
      updatedAt: now,
    };
    const query = (joinedRow: unknown) => ({
      select() {
        return {
          from() {
            return {
              leftJoin() {
                return {
                  where() {
                    return { limit: async () => (joinedRow ? [joinedRow] : []) };
                  },
                };
              },
            };
          },
        };
      },
    });
    const validDb = query({ slot, operation }) as unknown as Db;
    const brokenDb = query({ slot, operation: null }) as unknown as Db;
    expect(await discoverOwnerCallGrantOperation(validDb, ownerId, approvalId)).toMatchObject({
      kind: 'current',
      operation: { grantId: oldGrantId, phase: 'registered' },
    });
    expect(await discoverOwnerCallGrantOperation(brokenDb, ownerId, approvalId)).toEqual({
      kind: 'unavailable',
    });
    expect(
      await discoverOwnerCallGrantOperation(query(null) as unknown as Db, ownerId, approvalId),
    ).toEqual({
      kind: 'empty',
      generation: 0,
    });
  });

  it('rolls back replacement closure when registering the next receipt collides', async () => {
    const fixture = fakeDb();
    const result = await registerOwnerCallGrantOperation(fixture.db, {
      ownerId,
      approvalId,
      grantId: newGrantId,
      taskId,
      toolCallId,
      expectedSlotGeneration: 1,
      requestFingerprint: 'b'.repeat(64),
      grantScopeFingerprint: 'c'.repeat(64),
      reviewExpiresAt: new Date(now.getTime() + 30_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
      replaceUnadmittedRegistration: true,
      validateCurrentCall: vi.fn(async () => true),
    });

    expect(result).toEqual({ ok: false, reason: 'corrupt_or_unavailable' });
    expect(fixture.state().slot.generation).toBe(1);
    expect(fixture.state().slot.currentGrantId).toBe(oldGrantId);
    expect(fixture.state().operation.phase).toBe('registered');
  });

  it('throws from receipt finalization so existing caller decision writes roll back', async () => {
    const operation = {
      purpose: 'owner-call-grant-operation.v1',
      schemaVersion: 1,
      operationVersion: 1,
      ownerId,
      approvalId,
      grantId: oldGrantId,
      taskId,
      toolCallId,
      slotGeneration: 1,
      requestFingerprint: 'a'.repeat(64),
      grantScopeFingerprint: 'b'.repeat(64),
      phase: 'admitted',
      registeredAt: now,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
      admittedAt: new Date(now.getTime() + 1),
      committedAt: null,
      closedAt: null,
      rejectedAt: null,
      createdPolicyId: null,
      wakeGeneration: null,
      updatedAt: new Date(now.getTime() + 1),
    };
    const slot = {
      purpose: 'owner-call-grant-operation.v1',
      schemaVersion: 1,
      ownerId,
      approvalId,
      generation: 1,
      currentGrantId: oldGrantId,
      updatedAt: now,
    };
    let decisionCommitted = false;
    const tx = {
      async execute() {
        return [{ now: new Date(now.getTime() + 2) }];
      },
      update() {
        return {
          set() {
            return {
              where() {
                return { returning: async () => [] };
              },
            };
          },
        };
      },
    };
    const fakeDb = {
      async transaction<T>(body: (transaction: typeof tx) => Promise<T>) {
        const before = decisionCommitted;
        try {
          const result = await body(tx);
          return result;
        } catch (error) {
          decisionCommitted = before;
          throw error;
        }
      },
    } as unknown as Db;

    await expect(
      fakeDb.transaction(async (transaction) => {
        decisionCommitted = true; // stands in for approval, policy, task, and outbox writes
        return commitOwnerCallGrantOperationInTransaction(
          transaction as never,
          { slot, operation } as never,
          {
            createdPolicyId: '00000000-0000-4000-8000-000000000007',
            wakeGeneration: 3,
          },
        );
      }),
    ).rejects.toBeInstanceOf(OwnerCallGrantOperationRollbackError);
    expect(decisionCommitted).toBe(false);
  });

  it('reads the exact historical or current receipt in one joined point lookup', async () => {
    const currentGrantId = '00000000-0000-4000-8000-000000000008';
    const base = {
      purpose: 'owner-call-grant-operation.v1',
      schemaVersion: 1,
      operationVersion: 1,
      ownerId,
      approvalId,
      taskId,
      toolCallId,
      requestFingerprint: 'a'.repeat(64),
      grantScopeFingerprint: 'b'.repeat(64),
      phase: 'registered',
      registeredAt: now,
      reviewExpiresAt: new Date(now.getTime() + 60_000),
      grantExpiresAt: new Date(now.getTime() + 86_400_000),
      admittedAt: null,
      committedAt: null,
      closedAt: null,
      rejectedAt: null,
      createdPolicyId: null,
      wakeGeneration: null,
      updatedAt: now,
    };
    let selected = {
      slot: {
        purpose: 'owner-call-grant-operation.v1',
        schemaVersion: 1,
        ownerId,
        approvalId,
        generation: 2,
        currentGrantId,
        updatedAt: now,
      },
      operation: { ...base, grantId: oldGrantId, slotGeneration: 1 },
    };
    let queryCount = 0;
    const db = {
      select() {
        queryCount += 1;
        return {
          from() {
            return {
              leftJoin() {
                return {
                  where() {
                    return { limit: async () => [selected] };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Db;

    const historical = await readOwnerCallGrantOperationCheck(db, ownerId, approvalId, oldGrantId);
    expect(historical).toMatchObject({ status: 'available', isCurrent: false });
    expect(queryCount).toBe(1);

    queryCount = 0;
    selected = {
      ...selected,
      operation: { ...base, grantId: currentGrantId, slotGeneration: 2 },
    };
    const current = await readOwnerCallGrantOperationCheck(db, ownerId, approvalId, currentGrantId);
    expect(current).toMatchObject({ status: 'available', isCurrent: true });
    expect(queryCount).toBe(1);
  });
});
