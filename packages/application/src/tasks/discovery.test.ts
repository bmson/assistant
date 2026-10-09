import { randomUUID } from 'node:crypto';
import {
  agents,
  conversations,
  createDb,
  createPostgresTaskDiscoveryRepository,
  type Db,
  tasks,
} from '@assistant/db';
import { FirestoreTaskDiscoveryRepository } from '@assistant/firestore';
import {
  chatAdmissionCancellationTrigger,
  chatAdmissionExternalEventId,
  encodeDiscoveryCursor,
  type Records,
  type TaskDiscoveryInput,
  type TaskDiscoveryRow,
} from '@assistant/persistence';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeRecord } from '../../../firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../firestore/src/test-store.js';
import { discoverActivityWithRepository } from './discovery.js';

const at = new Date('2026-10-07T12:00:00Z');
const base: TaskDiscoveryInput = { archived: false, filter: 'all', limit: 100 };
function record(agentId: string, index: number): Records['tasks'] {
  const id = randomUUID();
  return {
    id,
    agentId,
    createdAt: at,
    updatedAt: at,
    type: 'adhoc',
    status: 'done',
    trigger: { source: 'chat', payload: { text: `request ${index}` } },
    trust: 'owner',
    tainted: false,
    conversationId: null,
    parentTaskId: null,
    goalId: null,
    externalEventId: `discovery:${agentId}:${index}`,
    title: `Request ${index}`,
    progress: '',
    progressPercent: null,
    archivedAt: null,
    autonomyGrant: null,
    spentUsd: '0',
    budgetUsdLimit: '1',
    maxSteps: 5,
    nextAction: '',
    plan: null,
    state: {},
    attempt: 0,
    reclaimCount: 0,
    wakeCount: 0,
    step: 0,
    attemptToken: null,
    leaseGeneration: 0,
    queueGeneration: 0,
    lockedBy: null,
    leaseExpiresAt: null,
    leaseRenewedAt: null,
    runAfter: at,
    deadline: null,
    approvalsCount: 0,
    maxWakeCount: 10,
    completedAt: null,
  } as unknown as Records['tasks'];
}
let db: Db;
let owner: string;
beforeAll(async () => {
  db = createDb(process.env.DATABASE_URL ?? 'postgres://assistant@127.0.0.1:55432/assistant');
  const [row] = await db
    .insert(agents)
    .values({
      name: 'Audit discovery test',
      email: `${randomUUID()}@example.test`,
      workspacePrefix: `discovery-${randomUUID()}`,
    })
    .returning();
  if (!row) throw new Error('Missing audit test owner');
  owner = row.id;
});
afterAll(async () => {
  if (owner) {
    await db.delete(tasks).where(eq(tasks.agentId, owner));
    await db.delete(conversations).where(eq(conversations.agentId, owner));
    await db.delete(agents).where(eq(agents.id, owner));
  }
  await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();
});
for (const driver of ['postgres', 'firestore'] as const)
  describe.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${driver} historical audit discovery`,
    () => {
      it('keeps pre-admission cancellation markers out of discovery while advancing the page boundary', async () => {
        const store = driver === 'firestore' ? emulatorStore() : null;
        const agentId = driver === 'postgres' ? owner : 'audit-owner';
        const conversationId = randomUUID();
        const markerRows = Array.from({ length: 501 }, (_, index) => {
          const clientOperationId = randomUUID();
          return {
            ...record(agentId, index),
            type: 'chat_turn',
            status: 'cancelled',
            conversationId,
            externalEventId: chatAdmissionExternalEventId({
              agentId,
              conversationId,
              clientOperationId,
            }),
            trigger: chatAdmissionCancellationTrigger({
              agentId,
              conversationId,
              clientOperationId,
            }),
            updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)),
          } as Records['tasks'];
        });
        const ordinary = {
          ...record(agentId, 900),
          title: 'visible ordinary task',
          updatedAt: new Date('2026-01-01T00:00:00Z'),
        };
        const rows = [...markerRows, ordinary];
        try {
          if (store) {
            await store.doc('agents', agentId).set({ id: agentId });
            for (let start = 0; start < rows.length; start += 100) {
              const batch = store.db.batch();
              for (const row of rows.slice(start, start + 100))
                batch.set(store.doc('tasks', row.id), encodeRecord(row));
              await batch.commit();
            }
          } else {
            await db
              .insert(conversations)
              .values({ id: conversationId, agentId, channel: 'chat', trust: 'owner' });
            await db.insert(tasks).values(
              rows.map((row) => ({
                id: row.id,
                agentId,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                type: row.type,
                status: row.status,
                title: row.title,
                progress: row.progress,
                trigger: row.trigger,
                trust: row.trust,
                conversationId: row.conversationId,
                externalEventId: row.externalEventId,
              })),
            );
          }
          const repository = store
            ? new FirestoreTaskDiscoveryRepository(store)
            : createPostgresTaskDiscoveryRepository(db);
          const visible: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 4; page += 1) {
            const result = await discoverActivityWithRepository(repository, agentId, {
              ...base,
              limit: 1,
              cursor,
            });
            visible.push(...result.items.map((item) => item.id));
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
          }
          expect(visible).toEqual([ordinary.id]);
          expect(visible.some((id) => markerRows.some((marker) => marker.id === id))).toBe(false);
        } finally {
          if (store) await disposeStore(store);
          else {
            await db.delete(tasks).where(
              inArray(
                tasks.id,
                rows.map((row) => row.id),
              ),
            );
            await db.delete(conversations).where(eq(conversations.id, conversationId));
          }
        }
      }, 60_000);

      it('finds old owner work beyond 500 records and pages equal timestamps without duplication', async () => {
        const store = driver === 'firestore' ? emulatorStore() : null;
        const agentId = driver === 'postgres' ? owner : 'audit-owner';
        const rows = Array.from({ length: 610 }, (_, index) => record(agentId, index));
        const target = {
          ...record(agentId, 999),
          title: 'needle older owner request',
          updatedAt: new Date('2025-01-01Z'),
          createdAt: new Date('2025-01-01Z'),
        };
        rows.push(target);
        try {
          if (store) {
            await store.doc('agents', agentId).set({ id: agentId });
            for (let start = 0; start < rows.length; start += 100) {
              const batch = store.db.batch();
              for (const row of rows.slice(start, start + 100))
                batch.set(store.doc('tasks', row.id), encodeRecord(row));
              await batch.commit();
            }
            const foreign = { ...record('foreign-owner', 99), title: target.title };
            await store.doc('tasks', foreign.id).set(encodeRecord(foreign));
          } else {
            await db.insert(tasks).values(
              rows.map((row) => ({
                id: row.id,
                agentId,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                type: row.type,
                status: row.status,
                title: row.title,
                progress: '',
                trigger: row.trigger,
                trust: 'owner',
                externalEventId: row.externalEventId,
              })),
            );
          }
          const repository = store
            ? new FirestoreTaskDiscoveryRepository(store)
            : createPostgresTaskDiscoveryRepository(db);
          const search = { ...base, q: 'needle', source: 'chat', trust: 'owner', type: 'adhoc' };
          const first = await discoverActivityWithRepository(repository, agentId, search);
          expect(first.items).toHaveLength(0);
          expect(first.scanned).toBe(500);
          expect(first.searchIncomplete).toBe(true);
          expect(first.nextCursor).toBeTruthy();
          const second = await discoverActivityWithRepository(repository, agentId, {
            ...search,
            cursor: first.nextCursor ?? undefined,
          });
          expect(second.items.map((item) => item.id)).toEqual([target.id]);
          expect(second.searchIncomplete).toBe(false);
          expect(second.items[0]).toMatchObject({
            conversationId: null,
            externalEventId: target.externalEventId,
            createdAt: target.createdAt,
          });
          await expect(
            discoverActivityWithRepository(repository, agentId, {
              ...search,
              q: 'other',
              cursor: first.nextCursor ?? undefined,
            }),
          ).rejects.toThrow('another owner or filter');
          const found: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 20; page++) {
            const result = await discoverActivityWithRepository(repository, agentId, {
              ...base,
              cursor,
            });
            found.push(...result.items.map((item) => item.id));
            if (!result.nextCursor) break;
            cursor = result.nextCursor;
          }
          expect(found).toHaveLength(rows.length);
          expect(new Set(found).size).toBe(rows.length);
        } finally {
          if (store) await disposeStore(store);
        }
      }, 60_000);
    },
  );

it('reports legacy unknown creation times and excludes them from date filters without inventing a timestamp', async () => {
  const row = {
    ...record(owner, 99),
    createdAt: null,
    source: 'chat',
  } as unknown as TaskDiscoveryRow;
  const repository = {
    driver: 'postgres' as const,
    scan: async () => ({
      rows: [row],
      hasMore: false,
      archivedCount: 0,
      pendingApprovalTaskIds: [],
    }),
  };
  const unfiltered = await discoverActivityWithRepository(repository, owner, base);
  expect(unfiltered.items[0]?.createdAt).toBeNull();
  expect(unfiltered.unknownCreatedTimeRows).toBe(1);
  const dated = await discoverActivityWithRepository(repository, owner, {
    ...base,
    from: '2020-01-01T00:00:00Z',
  });
  expect(dated.items).toEqual([]);
  expect(dated.unknownCreatedTimeRows).toBe(1);
  expect(dated.captureStatus).toContain('cannot be matched by date filters');
});

it('rejects malformed PostgreSQL cursor identities before a database query', async () => {
  let queried = false;
  const repository = {
    driver: 'postgres' as const,
    scan: async () => {
      queried = true;
      return { rows: [], hasMore: false, archivedCount: 0, pendingApprovalTaskIds: [] };
    },
  };
  const cursor = encodeDiscoveryCursor(owner, 'postgres', base, { at, id: 'not-a-uuid' });
  await expect(
    discoverActivityWithRepository(repository, owner, { ...base, cursor }),
  ).rejects.toThrow('cursor');
  expect(queried).toBe(false);
});
