import { randomUUID } from 'node:crypto';
import {
  agents,
  callSessions,
  createDb,
  createPostgresCallSessionRepository,
  type Db,
  tasks,
  toolCalls,
} from '@assistant/db';
import {
  createInstallationStore,
  FirestoreCallSessionRepository,
  type InstallationStore,
} from '@assistant/firestore';
import type { CallSessionRepository, CallVoiceRouteSnapshot } from '@assistant/persistence';
import { AmbiguousTwilioDeliveryError } from '@assistant/tools/calls';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const meter = vi.hoisted(() => ({
  reserveCost: vi.fn(async () => ({ ok: true, reservationId: randomUUID() })),
  releaseReservation: vi.fn(async () => {}),
  getRate: vi.fn(async () => ({ unit: 'minute', unitPriceUsd: 0.01 })),
}));
vi.mock('@assistant/core', async (original) => ({
  ...(await original<typeof import('@assistant/core')>()),
  ...meter,
}));
const { startCall } = await import('./dial.js');

const rates = {
  audioInputPerMTok: 1,
  audioOutputPerMTok: 1,
  textInputPerMTok: 1,
  textOutputPerMTok: 1,
};
const voiceRoute: CallVoiceRouteSnapshot = {
  version: 1,
  modelId: 'openai:synthetic-realtime',
  connectionId: 'openai',
  connectionKind: 'openai',
  connectionUpdatedAt: null,
  provider: 'openai',
  providerModel: 'synthetic-realtime',
  endpoint: { kind: 'openai-realtime', url: 'wss://api.openai.com/v1/realtime' },
  voice: null,
  rates,
};
const brief = {
  to: '+14155550123',
  goal: 'Synthetic test only',
  context: '',
  mayAgreeTo: '',
  mustNot: '',
  language: 'en',
  maxMinutes: 1,
  onVoicemail: 'hang_up' as const,
};

for (const driver of ['postgres', 'firestore'] as const) {
  describe.skipIf(
    driver === 'firestore' ? !process.env.FIRESTORE_EMULATOR_HOST : !process.env.DATABASE_URL,
  )(`${driver} owner call admission`, () => {
    let db: Db | undefined;
    let store: InstallationStore | undefined;
    let ownerId: string;
    let callTasks: string[];
    let calls: CallSessionRepository;

    async function fixture(dailyLimit = 1) {
      ownerId = randomUUID();
      callTasks = [randomUUID(), randomUUID()];
      const toolIds = [randomUUID(), randomUUID()];
      if (driver === 'postgres') {
        const url = process.env.DATABASE_URL;
        if (!url || !new URL(url).pathname.endsWith('_test'))
          throw new Error('Requires isolated test database');
        db = createDb(url);
        await db.insert(agents).values({
          id: ownerId,
          name: 'Synthetic calls',
          email: `${ownerId}@calls.invalid`,
          workspacePrefix: `test/${ownerId}`,
        });
        await db
          .insert(tasks)
          .values(callTasks.map((id) => ({ id, agentId: ownerId, type: 'adhoc', trust: 'owner' })));
        await db.insert(toolCalls).values(
          toolIds.map((id, index) => ({
            id,
            taskId: callTasks[index] as string,
            step: 0,
            toolName: 'phone.call',
            risk: 'approval',
            status: 'executing',
            args: {},
          })),
        );
        calls = createPostgresCallSessionRepository(db);
      } else {
        store = createInstallationStore({
          projectId: 'demo-assistant-test',
          installationId: `call-capacity-${ownerId}`,
        });
        calls = new FirestoreCallSessionRepository(store, ownerId);
      }
      const now = new Date();
      const input = (index: number) => ({
        callId: randomUUID(),
        brief,
        callbackToken: 'synthetic-callback',
        ctx: {
          taskId: callTasks[index],
          now: () => now,
          execution: {
            dbToolCallId: toolIds[index],
            modelToolCallId: `model-${index}`,
            toolName: 'phone.call',
          },
        } as never,
      });
      const dialer = {
        configured: () => true,
        placeCall: vi.fn(async () => ({ sid: `CA${randomUUID().replaceAll('-', '')}` })),
        hangup: vi.fn(async () => {}),
        getCall: vi.fn(async () => {
          throw new Error('Synthetic tests never call the provider');
        }),
      };
      const deps = {
        config: {
          PUBLIC_URL: 'https://synthetic.invalid',
          OWNER_NAME: 'Synthetic',
          CALL_DAILY_LIMIT: dailyLimit,
          CALL_MAX_MINUTES: 1,
        },
        calls,
        costs: {} as never,
        dialer,
        ownerId: async () => ownerId,
        voiceModel: async () => ({
          id: voiceRoute.modelId,
          route: voiceRoute,
          resolved: { provider: {} as never, model: voiceRoute.providerModel, rates },
        }),
      };
      const admissionInput = (id: string, index: number) => ({
        id,
        agentId: ownerId,
        taskId: callTasks[index] as string,
        toolCallId: toolIds[index] as string,
        status: 'dialing',
        to: brief.to,
        contactName: null,
        brief,
        voiceModel: voiceRoute.modelId,
        voiceRoute,
        maxMinutes: 1,
        streamTokenHash: 'synthetic-hash',
        callbackToken: 'synthetic-callback',
        reservationId: null,
      });
      return { deps, dialer, input, now, admissionInput };
    }

    afterEach(async () => {
      if (store) {
        await store.db.recursiveDelete(store.root);
        await store.db.terminate();
        store = undefined;
      }
      if (db) {
        await db.delete(callSessions).where(eq(callSessions.agentId, ownerId));
        await db.delete(toolCalls).where(inArray(toolCalls.taskId, callTasks));
        await db.delete(tasks).where(eq(tasks.agentId, ownerId));
        await db.delete(agents).where(eq(agents.id, ownerId));
        await db.$client.end();
        db = undefined;
      }
      vi.clearAllMocks();
    });

    it('allows only one provider dial for two concurrent distinct tasks with one slot/day capacity', async () => {
      const { deps, dialer, input } = await fixture();
      const results = await Promise.allSettled([
        startCall(deps, input(0)),
        startCall(deps, input(1)),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(dialer.placeCall).toHaveBeenCalledTimes(1);
      expect(await calls.countSince(ownerId, new Date(Date.now() - 60_000))).toBe(1);
    }, 60_000);

    it('keeps ambiguous and stale admissions in daily capacity and never redials their identity', async () => {
      const { deps, dialer, input, now } = await fixture();
      const first = input(0);
      dialer.placeCall.mockRejectedValueOnce(new AmbiguousTwilioDeliveryError('Synthetic timeout'));
      await expect(startCall(deps, first)).rejects.toThrow('Synthetic timeout');
      await expect(startCall(deps, first)).rejects.toThrow('existing call admission');
      await expect(startCall(deps, input(1))).rejects.toThrow('still in progress');
      await calls.finish(first.callId, {
        status: 'failed',
        endedAt: now,
        error: 'stale unknown outcome',
      });
      await expect(startCall(deps, input(1))).rejects.toThrow('daily limit');
      expect(dialer.placeCall).toHaveBeenCalledTimes(1);
      expect((await calls.get(first.callId))?.capacityReleasedAt ?? null).toBeNull();
    }, 60_000);

    it('survives a crash after admission without dialing its replay or freeing capacity', async () => {
      const { deps, dialer, input, now, admissionInput } = await fixture();
      const first = input(0);
      expect(
        await calls.admit(admissionInput(first.callId, 0), { now, dailyLimit: 1 }),
      ).toMatchObject({ kind: 'admitted' });
      // A new repository instance reads only persisted state after the lost process.
      deps.calls =
        driver === 'postgres'
          ? createPostgresCallSessionRepository(db as Db)
          : new FirestoreCallSessionRepository(store as InstallationStore, ownerId);
      await expect(startCall(deps, first)).rejects.toThrow('existing call admission');
      await expect(startCall(deps, input(1))).rejects.toThrow('still in progress');
      expect(dialer.placeCall).not.toHaveBeenCalled();
    }, 60_000);

    it('counts a completed call against the daily limit after its active slot frees', async () => {
      const { deps, dialer, input, now } = await fixture();
      const first = input(0);
      await startCall(deps, first);
      await calls.finish(first.callId, { status: 'completed', endedAt: now });
      await expect(startCall(deps, input(1))).rejects.toThrow('daily limit');
      expect(dialer.placeCall).toHaveBeenCalledTimes(1);
    }, 60_000);

    it('releases definite refusal once so a fresh operation can use the slot', async () => {
      const { deps, dialer, input, now } = await fixture();
      const first = input(0);
      dialer.placeCall.mockRejectedValueOnce(new Error('Synthetic provider refusal'));
      await expect(startCall(deps, first)).rejects.toThrow('Synthetic provider refusal');
      expect((await calls.get(first.callId))?.capacityReleasedAt).toBeInstanceOf(Date);
      expect(await calls.releaseAdmission(first.callId, now)).toBe(false);
      await startCall(deps, input(1));
      expect(dialer.placeCall).toHaveBeenCalledTimes(2);
    }, 60_000);

    it('keeps the admission when the provider accepted but saving its SID fails', async () => {
      const { deps, dialer, input } = await fixture();
      const first = input(0);
      vi.spyOn(calls, 'update').mockRejectedValueOnce(new Error('Synthetic receipt failure'));
      await expect(startCall(deps, first)).rejects.toThrow('provider accepted');
      await expect(startCall(deps, input(1))).rejects.toThrow('still in progress');
      expect(dialer.placeCall).toHaveBeenCalledTimes(1);
      expect(meter.releaseReservation).toHaveBeenCalledTimes(1); // refused second task's new hold only
      expect((await calls.get(first.callId))?.status).toBe('dialing');
    }, 60_000);
  });
}
