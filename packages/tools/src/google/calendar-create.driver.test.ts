import { randomUUID } from 'node:crypto';
import {
  agents,
  approvalPolicies,
  approvals as approvalRows,
  createDb,
  createPostgresApprovalPolicyRepository,
  createPostgresApprovalRepository,
  createPostgresCostRepository,
  createPostgresGoogleCalendarConnectionRepository,
  createPostgresToolExecutionRepository,
  type Db,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  createFirestoreGoogleCalendarConnectionRepository,
  FirestoreApprovalPolicyRepository,
  FirestoreApprovalRepository,
  FirestoreCostRepository,
  FirestoreToolExecutionRepository,
  type InstallationStore,
} from '@assistant/firestore';
import type {
  ApprovalPolicyRepository,
  ApprovalRepository,
  CostRepository,
  GoogleCalendarConnectionRepository,
  Records,
  ToolExecutionRepository,
} from '@assistant/persistence';
import { GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE } from '@assistant/persistence';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { disposeStore, emulatorStore } from '../../../firestore/src/test-store.js';
import { ToolDispatcher } from '../dispatcher.js';
import { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../types.js';
import { registerAccountAwareCalendarTools } from './calendar-connection.js';
import { AmbiguousGoogleMutationError, GoogleApiError, GoogleClient } from './client.js';

for (const driver of ['postgres', 'firestore'] as const) {
  describe.skipIf(driver === 'firestore' && !process.env.FIRESTORE_EMULATOR_HOST)(
    `${driver} personal Calendar approval/recovery`,
    () => {
      let db: Db, store: InstallationStore | undefined, owner: string, task: Records['tasks'];
      let connection: GoogleCalendarConnectionRepository,
        execution: ToolExecutionRepository,
        approvals: ApprovalRepository,
        policies: ApprovalPolicyRepository,
        costs: CostRepository;
      let registry: ToolRegistry, dispatcher: ToolDispatcher, context: ToolContext;
      let api: MockInstance<GoogleClient['api']>, legacyApi: MockInstance<GoogleClient['api']>;
      let canonical: Record<string, unknown> | undefined, loseResponse: boolean, failRead: boolean;
      let scopeId: string;
      const input = {
        account: 'personal',
        calendarId: 'primary',
        summary: 'Approved personal event',
        start: '2026-11-20T10:00:00Z',
        end: '2026-11-20T11:00:00Z',
      };
      const provenance = { plannerVersion: 1, promptVersion: 1, model: 'synthetic/test' };
      function reopen() {
        if (driver === 'postgres') {
          connection = createPostgresGoogleCalendarConnectionRepository(db);
          execution = createPostgresToolExecutionRepository(db);
          approvals = createPostgresApprovalRepository(db);
          policies = createPostgresApprovalPolicyRepository(db);
          costs = createPostgresCostRepository(db);
        } else {
          if (!store) throw Error('Missing emulator store');
          connection = createFirestoreGoogleCalendarConnectionRepository(store);
          execution = new FirestoreToolExecutionRepository(store);
          approvals = new FirestoreApprovalRepository(store);
          policies = new FirestoreApprovalPolicyRepository(store);
          costs = new FirestoreCostRepository(store);
        }
      }
      function install() {
        const client = new GoogleClient({
          clientId: 'personal',
          clientSecret: 'stable-connection-test-secret',
          refreshToken: 'test-only',
        });
        const legacy = new GoogleClient({
          clientId: 'legacy',
          clientSecret: 'legacy',
          refreshToken: 'test-only',
        });
        legacyApi = vi.spyOn(legacy, 'api').mockResolvedValue({ id: 'legacy' });
        api = vi.spyOn(client, 'api').mockImplementation(async (url, init) => {
          if (String(url).includes('/calendarList/'))
            return {
              id: 'calendar@example.com',
              summary: 'Personal calendar',
              accessRole: 'owner',
            };
          if ((init as RequestInit | undefined)?.method === 'POST') {
            canonical = {
              ...JSON.parse(String((init as RequestInit).body)),
              status: 'confirmed',
              htmlLink: 'https://calendar.google.com/calendar/event?eid=synthetic',
            };
            if (loseResponse) throw new AmbiguousGoogleMutationError('simulated response loss');
            return structuredClone(canonical);
          }
          if (failRead || !canonical)
            throw new GoogleApiError(503, 'simulated unavailable', String(url));
          return structuredClone(canonical);
        });
        registry = new ToolRegistry();
        registerAccountAwareCalendarTools(registry, {
          client: legacy,
          botEmail: 'assistant@example.com',
          ownerEmail: 'owner@example.com',
          creationExecution: execution,
          personalAccount: async (agentId) => {
            const c = (await connection.get(agentId))?.connection;
            if (!c) throw Error('Personal connection disconnected');
            return {
              ...c.account,
              client,
              connectionId: c.id,
              calendarWrite: c.scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE),
            };
          },
        });
        dispatcher = new ToolDispatcher(db, registry, execution, costs, approvals, policies);
      }
      async function patchTask(value: Record<string, unknown>) {
        if (driver === 'postgres') await db.update(tasks).set(value).where(eq(tasks.id, task.id));
        else await store?.doc('tasks', task.id).update(value);
        Object.assign(task, value);
      }
      beforeEach(async () => {
        owner = randomUUID();
        canonical = undefined;
        loseResponse = false;
        failRead = false;
        if (driver === 'postgres') {
          const url = process.env.DATABASE_URL;
          if (!url || !new URL(url).pathname.endsWith('_test'))
            throw Error('Isolated test database required');
          db = createDb(url);
          await db.insert(agents).values({
            id: owner,
            name: 'Synthetic Calendar',
            email: owner + '@example.com',
            workspacePrefix: owner,
          });
          const [row] = await db
            .insert(tasks)
            .values({ agentId: owner, type: 'adhoc', status: 'running', trust: 'owner' })
            .returning();
          if (!row) throw Error('Missing task');
          task = row;
        } else {
          store = emulatorStore();
          db = {} as Db;
          await store
            .doc('agents', owner)
            .set({ id: owner, name: 'Synthetic Calendar', email: 'owner@example.com' });
          task = {
            id: randomUUID(),
            agentId: owner,
            type: 'adhoc',
            status: 'running',
            trust: 'owner',
            createdAt: new Date(),
            updatedAt: new Date(),
            queueGeneration: 0,
            stepCount: 0,
          } as unknown as Records['tasks'];
          await store.doc('tasks', task.id).set(task);
        }
        reopen();
        const flow = {
          id: randomUUID(),
          nonce: 'nonce',
          stateHash: 'e'.repeat(64),
          verifierEncrypted: 'sealed-test',
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          outcome: 'pending' as const,
        };
        await connection.begin(owner, flow);
        const claim = await connection.consume(owner, flow.id, flow.stateHash, new Date());
        if (!claim) throw Error('Missing claim');
        scopeId = flow.id;
        await connection.finish(
          owner,
          flow.id,
          claim.revision,
          'connected',
          {
            id: flow.id,
            credentialVersion: 0,
            accessTokenEncrypted: 'sealed-access',
            accessTokenExpiresAt: new Date(Date.now() + 3600000).toISOString(),
            refreshLease: null,
            account: { subject: 'subject', email: 'owner@example.com' },
            refreshTokenEncrypted: 'sealed-refresh',
            scopes: ['openid', 'email', GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE],
            status: 'connected',
            connectedAt: new Date().toISOString(),
          },
          new Date(),
        );
        context = {
          agentId: owner,
          taskId: task.id,
          trust: 'owner',
          tainted: false,
          db,
          now: () => new Date(),
          signal: new AbortController().signal,
          log: async () => {},
        };
        install();
      });
      afterEach(async () => {
        vi.restoreAllMocks();
        if (store) {
          await disposeStore(store);
          store = undefined;
        }
        if (driver === 'postgres' && db) {
          await db.update(toolCalls).set({ approvalId: null }).where(eq(toolCalls.taskId, task.id));
          await db.delete(approvalRows).where(eq(approvalRows.taskId, task.id));
          await db.delete(toolCalls).where(eq(toolCalls.taskId, task.id));
          await db.delete(tasks).where(eq(tasks.agentId, owner));
          await db.delete(approvalPolicies).where(eq(approvalPolicies.agentId, owner));
          await db.delete(agents).where(eq(agents.id, owner));
          await db.$client.end({ timeout: 5 });
        }
      });
      async function dispatch() {
        return dispatcher.dispatch({
          task,
          step: 1,
          toolName: 'calendar.create_event',
          args: input,
          ctx: context,
          provenance,
          modelToolCallId: 'stable-original-operation',
        });
      }
      it('requires a personal approval even under a standing assistant rule and free-range grant; denial makes no POST', async () => {
        const rule = {
          id: randomUUID(),
          agentId: owner,
          toolName: 'calendar.create_event',
          templateKey: 'calendar.self_only_events',
          match: {},
          effect: 'allow' as const,
          version: 1,
          createdVia: 'settings',
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        if (driver === 'postgres') await db.insert(approvalPolicies).values(rule);
        else await store?.doc('approvalPolicies', rule.id).set(rule);
        await patchTask({
          autonomyGrant: {
            grantedAt: new Date().toISOString(),
            grantedVia: 'composer',
            expiresAt: new Date(Date.now() + 3600000).toISOString(),
            revokedAt: null,
          },
        });
        const pending = await dispatch();
        expect(pending).toMatchObject({ kind: 'awaiting_approval' });
        if (pending.kind !== 'awaiting_approval') throw Error('Expected approval');
        expect(
          await approvals.resolve({
            approvalId: pending.approvalId,
            expectedAgentId: owner,
            decision: 'denied',
            via: 'web',
            deferNotification: true,
          }),
        ).toMatchObject({ ok: true });
        expect((await dispatcher.executeApproved(pending.toolCallId, context)).kind).toBe('failed');
        expect(
          api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
        ).toHaveLength(0);
        expect(legacyApi).not.toHaveBeenCalled();
      });
      it('serializes approved execution and replays its canonical result without another write', async () => {
        const pending = await dispatch();
        if (pending.kind !== 'awaiting_approval') throw Error('Expected approval');
        await approvals.resolve({
          approvalId: pending.approvalId,
          decision: 'approved',
          via: 'web',
          expectedAgentId: owner,
          deferNotification: true,
        });
        await patchTask({ status: 'running' });
        const results = await Promise.all([
          dispatcher.executeApproved(pending.toolCallId, context),
          dispatcher.executeApproved(pending.toolCallId, context),
        ]);
        expect(
          results.some(
            (x) =>
              x.kind === 'executed' &&
              (x.result as { sameOperationReadback?: boolean }).sameOperationReadback,
          ),
          JSON.stringify(results),
        ).toBe(true);
        const posts = api.mock.calls.filter(
          ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(posts).toHaveLength(1);
        const original = await execution.load(owner, task.id, pending.toolCallId);
        expect(original?.toolCall.decision).toMatchObject({
          externalEffect: { kind: 'calendar_event', stage: 'verified' },
        });
        reopen();
        install();
        expect(await dispatcher.executeApproved(pending.toolCallId, context)).toMatchObject({
          kind: 'executed',
          result: { effectStatus: 'completed' },
        });
        expect(api).not.toHaveBeenCalled();
        expect(legacyApi).not.toHaveBeenCalled();
      });
      it('retains uncertain delivery across repository restart and reconciles only the original event', async () => {
        const pending = await dispatch();
        if (pending.kind !== 'awaiting_approval') throw Error('Expected approval');
        await approvals.resolve({
          approvalId: pending.approvalId,
          decision: 'approved',
          via: 'web',
          expectedAgentId: owner,
          deferNotification: true,
        });
        await patchTask({ status: 'running' });
        loseResponse = true;
        failRead = true;
        expect(await dispatcher.executeApproved(pending.toolCallId, context)).toMatchObject({
          kind: 'executed',
          result: {
            deliveryStatus: 'unknown',
            retrySuppressed: true,
            reconciliation: {
              toolName: 'calendar.reconcile_event_creation',
              taskId: task.id,
              toolCallId: pending.toolCallId,
            },
          },
        });
        expect(
          api.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST'),
        ).toHaveLength(1);
        expect(await execution.load(randomUUID(), task.id, pending.toolCallId)).toBeNull();
        reopen();
        install();
        failRead = false;
        expect(await dispatcher.executeApproved(pending.toolCallId, context)).toMatchObject({
          kind: 'executed',
          result: { deliveryStatus: 'unknown' },
        });
        const tool = registry.get('calendar.reconcile_event_creation')?.tool;
        if (!tool) throw Error('Missing reconciliation');
        expect(
          await tool.execute({ taskId: task.id, toolCallId: pending.toolCallId }, context),
        ).toMatchObject({
          effectStatus: 'completed',
          sameOperationReadback: true,
          calendarAccount: { connectionId: scopeId },
        });
        expect(
          api.mock.calls.every(([, init]) => (init as RequestInit | undefined)?.method !== 'POST'),
        ).toBe(true);
        expect(legacyApi).not.toHaveBeenCalled();
      });
      it.each(['connection', 'edited-calendar', 'edited-account'])(
        'rejects %s drift after approval before any provider POST',
        async (scenario) => {
          const pending = await dispatch();
          if (pending.kind !== 'awaiting_approval') throw Error('Expected approval');
          const original = (await execution.load(owner, task.id, pending.toolCallId))?.toolCall
            .args as Record<string, unknown>;
          await approvals.resolve({
            approvalId: pending.approvalId,
            decision: 'approved',
            via: 'web',
            expectedAgentId: owner,
            deferNotification: true,
            ...(scenario.startsWith('edited')
              ? {
                  editedPayload: {
                    ...original,
                    ...(scenario === 'edited-account'
                      ? { account: 'assistant' }
                      : { calendarId: 'other' }),
                  },
                }
              : {}),
          });
          if (scenario === 'connection') await connection.disconnect(owner);
          await patchTask({ status: 'running' });
          expect((await dispatcher.executeApproved(pending.toolCallId, context)).kind).toBe(
            'failed',
          );
          expect(
            api.mock.calls.filter(
              ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
            ),
          ).toHaveLength(0);
          expect(legacyApi).not.toHaveBeenCalled();
        },
      );
    },
  );
}
