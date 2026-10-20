import { randomUUID } from 'node:crypto';
import {
  type ExecutorDeps,
  executeTask,
  goalAutomationInstruction,
  prepareGoalSession,
  runScheduleBatch,
  type StepCallOutcome,
} from '@assistant/core';
import type { Db } from '@assistant/db';
import {
  createFirestoreExecutionPersistence,
  FirestoreGoalMutationRepository,
  FirestoreGoalProgressRepository,
  FirestoreScheduleRepository,
} from '@assistant/firestore';
import { finalChannelDelivery, type Records } from '@assistant/persistence';
import { ToolDispatcher, ToolRegistry } from '@assistant/tools';
import { registerPortableGoalProgressTool } from '@assistant/tools/builtin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { decodeRecord, type InstallationStore } from '../../../packages/firestore/src/store.js';
import { disposeStore, emulatorStore } from '../../../packages/firestore/src/test-store.js';

/**
 * Deterministic lifecycle rehearsal, not live-model/provider acceptance.
 * One installation retains the goal, revisioned fictional corpus, artifacts,
 * schedule, owner messages, tool ledger and delivery checkpoints across turns.
 * Run through pnpm test: its credential scrubber and loopback-only network
 * preload fence egress independently of the tool registry below.
 */
describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'isolated stateful proactive follow-through',
  () => {
    const owner = randomUUID();
    let store: InstallationStore;
    let deps: ExecutorDeps;
    let persistence: ReturnType<typeof createFirestoreExecutionPersistence>;
    let mutations: FirestoreGoalMutationRepository;
    let schedules: FirestoreScheduleRepository;
    let goalId: string;
    let conversationId: string;
    let clock: Date;
    let script: StepCallOutcome[];
    let onStep: (() => Promise<void>) | undefined;
    let onPrepare: (() => Promise<void>) | undefined;
    let step: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<StepCallOutcome>>>;
    let deliver: ReturnType<typeof vi.fn<NonNullable<ExecutorDeps['deliverFinal']>>>;
    let notify: ReturnType<typeof vi.fn<NonNullable<ExecutorDeps['notifyOwner']>>>;
    let send: ReturnType<typeof vi.fn<() => Promise<never>>>;

    const tool = (name: string, input: Record<string, unknown> = {}): StepCallOutcome => ({
      ok: true,
      modelId: 'fixture/script',
      degraded: false,
      text: '',
      toolCalls: [{ toolCallId: randomUUID(), toolName: name, input }],
    });
    const final = (text: string): StepCallOutcome => ({
      ok: true,
      modelId: 'fixture/script',
      degraded: false,
      text,
      toolCalls: [],
      finishReason: 'stop',
    });

    beforeEach(async () => {
      // Do not silently run without the independent process-level egress fence.
      expect(process.env.ASSISTANT_TEST_NO_EXTERNAL_CREDENTIALS).toBe('1');
      await expect(fetch('https://qa-egress.invalid')).rejects.toThrow(
        'External network access is disabled',
      );
      clock = new Date();
      // Keep Date construction and Date.now aligned for gRPC deadlines while
      // advancing the fixture's application clock between scheduled turns.
      vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
      vi.setSystemTime(clock);
      store = emulatorStore(() => clock);
      const db = new Proxy(
        {},
        {
          get: () => {
            throw new Error('SQL is fenced');
          },
        },
      ) as Db;
      persistence = createFirestoreExecutionPersistence(store, owner, {
        provider: 'synthetic',
        model: 'fixture',
        dimensions: 1536,
        revision: '1',
      });
      await store
        .doc('agents', owner)
        .set({ id: owner, name: 'Fictional QA owner', timezone: 'UTC' });
      const registry = new ToolRegistry();
      registerPortableGoalProgressTool(registry, new FirestoreGoalProgressRepository(store, owner));
      registry.register({
        name: 'qa.inspect',
        description: 'Inspect the supplied fictional source revision.',
        inputSchema: z.object({}),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async () => (await store.doc('qaCorpus', 'venue').get()).data(),
      });
      registry.register({
        name: 'qa.prepare',
        description: 'Prepare a reversible local QA comparison.',
        inputSchema: z.object({ revision: z.number(), choice: z.string() }),
        risk: 'autonomous',
        acceptsUntrustedInput: true,
        execute: async (input) => {
          await store.doc('qaArtifacts', 'comparison').set(input as Record<string, unknown>);
          await onPrepare?.();
          return { ok: true, prepared: input };
        },
      });
      send = vi.fn(async () => {
        throw new Error('External send is fenced');
      });
      registry.register({
        name: 'qa.send',
        description: 'Approval-bound fictional outreach; never sends.',
        inputSchema: z.object({}),
        risk: 'approval',
        acceptsUntrustedInput: true,
        execute: send,
      });
      script = [];
      onStep = undefined;
      onPrepare = undefined;
      step = vi.fn(async () => {
        await onStep?.();
        const next = script.shift();
        if (!next) throw new Error('Unexpected extra model step');
        return next;
      });
      deliver = vi.fn(async (_task, _text, attemptId) =>
        finalChannelDelivery('dashboard', 'not_applicable', attemptId, 'qa-egress-fenced'),
      );
      notify = vi.fn(async () => ({
        legs: [{ channel: 'push', status: 'skipped' as const, reason: 'qa-egress-fenced' }],
      }));
      deps = {
        db,
        persistence,
        router: {
          step,
          object: async (role: string) => ({
            ok: true,
            modelId: 'fixture/script',
            degraded: false,
            object:
              role === 'plan'
                ? {
                    action: 'workflow',
                    reasoning: 'Use the supplied corpus',
                    steps: ['Inspect'],
                    missingInfo: [],
                  }
                : { decision: 'publish', reasons: [] },
          }),
          embeddingSpace: async () => ({
            provider: 'synthetic',
            model: 'fixture',
            dimensions: 1536,
            revision: '1',
          }),
          embed: async () => [Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))],
        } as unknown as ExecutorDeps['router'],
        dispatcher: new ToolDispatcher(
          db,
          registry,
          persistence.toolExecution,
          persistence.costs,
          persistence.approvals,
          persistence.approvalPolicies,
        ),
        deliverFinal: deliver,
        notifyOwner: notify,
        notifyApproval: async () => undefined,
      };
      mutations = new FirestoreGoalMutationRepository(store, owner);
      schedules = new FirestoreScheduleRepository(store);
      const created = await mutations.createFromTool(
        {
          title: 'Compare fictional venues',
          description:
            'Use only the supplied QA corpus; prepare comparisons locally. Ask before sending.',
          priority: 3,
          progress: '',
          nextAction: '',
          targetDate: null,
          mirrorToPrimary: false,
          taintedOrigin: false,
        },
        (goal) => ({
          cron: '0 * * * *',
          instruction: goalAutomationInstruction(goal),
          nextRunAt: () => clock,
        }),
      );
      ({ goalId, conversationId } = created);
      await store
        .doc('qaCorpus', 'venue')
        .set({ revision: 1, choice: 'Cedar', reason: 'Accessible entrance confirmed' });
    });

    afterEach(async () => {
      try {
        expect(send).not.toHaveBeenCalled();
        expect((await store.collection('costEvents').get()).empty).toBe(true);
        expect((await store.collection('costReservations').get()).empty).toBe(true);
      } finally {
        try {
          await disposeStore(store);
        } finally {
          vi.useRealTimers();
          vi.restoreAllMocks();
        }
      }
    });

    async function tick() {
      clock = new Date(clock.getTime() + 3_600_000);
      vi.setSystemTime(clock);
      return runScheduleBatch(schedules, 'UTC', {
        now: clock,
        prepareGoal: (_row, template) =>
          prepareGoalSession(
            {
              goals: persistence.goals,
              tasks: persistence.tasks,
            },
            owner,
            template,
          ),
      });
    }
    async function fire(outcomes: StepCallOutcome[]) {
      script = outcomes;
      const fired = await tick();
      expect(fired).toHaveLength(1);
      const id = fired[0]?.taskId;
      if (!id) throw new Error('Missing scheduled fixture task');
      const result = await executeTask(deps, id);
      expect(script).toHaveLength(0);
      return { id, result };
    }
    async function messages() {
      return (
        await store.collection('messages').where('conversationId', '==', conversationId).get()
      ).docs.map((doc) => doc.data());
    }
    async function readTask(id: string) {
      return decodeRecord<Records['tasks']>((await store.doc('tasks', id).get()).data());
    }

    it('retains useful work, stays quiet on repeated checks, carries owner steering, and reports a source change once', async () => {
      const first = await fire([
        tool('qa.inspect'),
        tool('qa.prepare', { revision: 1, choice: 'Cedar' }),
        final(
          'Cedar has a confirmed accessible entrance. The local comparison is ready for review.',
        ),
      ]);
      expect(first.result.outcome).toBe('done');
      const initialCount = (await messages()).length;
      expect((await store.doc('qaArtifacts', 'comparison').get()).get('choice')).toBe('Cedar');
      const firstLedger = await persistence.executionEvidence.taskEvidence({
        agentId: owner,
        taskId: first.id,
      });
      expect(firstLedger.filter((row) => row.toolName === 'goals.update_progress')).toHaveLength(2);
      deliver.mockClear();
      notify.mockClear();
      for (let repeat = 0; repeat < 3; repeat++) {
        const checked = await fire([tool('qa.inspect'), final('')]);
        expect(checked.result.outcome).toBe('done');
        expect((await readTask(checked.id)).state).toMatchObject({
          pendingFinal: { completionKind: 'successful_silent' },
        });
      }
      expect((await messages()).length).toBe(initialCount);
      expect(deliver).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();

      await persistence.messages.append({
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'Prioritize Birch; keep the accessible entrance requirement.',
        parts: [
          { type: 'text', text: 'Prioritize Birch; keep the accessible entrance requirement.' },
        ],
      });
      // Owner steering changes preparation before any source revision changes.
      const steered = await fire([
        tool('qa.inspect'),
        tool('qa.prepare', { revision: 1, choice: 'Birch (accessibility unverified)' }),
        final(
          'The local comparison now prioritizes Birch. Its accessible entrance still needs verification before a decision.',
        ),
      ]);
      expect(steered.result.outcome).toBe('done');
      expect((await store.doc('qaCorpus', 'venue').get()).get('revision')).toBe(1);
      expect((await store.doc('qaArtifacts', 'comparison').get()).get('choice')).toContain(
        'unverified',
      );
      await store
        .doc('qaCorpus', 'venue')
        .set({ revision: 2, choice: 'Birch', reason: 'Step-free route now confirmed' });
      const changed = await fire([
        tool('qa.inspect'),
        tool('qa.prepare', { revision: 2, choice: 'Birch' }),
        final(
          'Birch now has a confirmed step-free route. The updated local comparison follows your new priority; review it before deciding.',
        ),
      ]);
      expect(changed.result.outcome).toBe('done');
      expect(JSON.stringify(step.mock.calls).includes('Prioritize Birch')).toBe(true);
      expect((await store.doc('qaArtifacts', 'comparison').get()).data()).toEqual({
        revision: 2,
        choice: 'Birch',
      });
      const afterChange = (await messages()).length;
      expect(afterChange).toBe(initialCount + 3);
      expect((await fire([tool('qa.inspect'), final('')])).result.outcome).toBe('done');
      expect((await messages()).length).toBe(afterChange);
    });

    it('parks an unauthorized send and suppresses repeated decision requests until the owner replies', async () => {
      const attempt = await fire([tool('qa.send')]);
      expect(attempt.result.outcome).toBe('parked');
      expect((await readTask(attempt.id)).status).toBe('waiting_approval');
      expect((await store.collection('approvals').get()).size).toBe(1);
      const count = (await messages()).length;
      expect(await tick()).toEqual([]);
      expect((await messages()).length).toBe(count);
    });

    it('keeps an unanswered decision quiet, then resumes with the actual owner reply', async () => {
      const fired = await tick();
      const id = fired[0]?.taskId;
      if (!id) throw new Error('Missing decision fixture task');
      await store.doc('tasks', id).update({
        plan: {
          action: 'clarify',
          reasoning: 'The fictional venue budget is missing',
          steps: [],
          missingInfo: ['What is the venue budget?'],
        },
      });
      expect((await executeTask(deps, id)).outcome).toBe('needs_attention');
      expect((await store.doc('goals', goalId).get()).get('nextAction')).toContain(
        'Waiting on the owner:',
      );
      const count = (await messages()).length;
      for (let repeat = 0; repeat < 3; repeat++) expect(await tick()).toEqual([]);
      expect((await messages()).length).toBe(count);
      await persistence.messages.append({
        conversationId,
        role: 'user',
        origin: 'owner',
        text: 'The fictional venue budget is $200.',
        parts: [{ type: 'text', text: 'The fictional venue budget is $200.' }],
      });
      const resumed = await fire([
        tool('qa.inspect'),
        final(
          'Cedar remains the option with confirmed accessibility. The comparison can now use the supplied budget.',
        ),
      ]);
      expect(resumed.result.outcome).toBe('done');
      expect((await readTask(id)).status).toBe('cancelled');
      expect(JSON.stringify(step.mock.calls).includes('fictional venue budget is $200')).toBe(true);
    });

    it.each([false, true])(
      'retains a real blocked owner decision after a rejected final is accepted (crash=%s)',
      async (crashAfterAcceptance) => {
        const fired = await tick();
        const id = fired[0]?.taskId;
        if (!id) throw new Error('Missing decision fixture task');
        await store.doc('tasks', id).update({
          plan: {
            action: 'clarify',
            reasoning: 'The fictional venue budget is missing',
            steps: [],
            missingInfo: ['What is the venue budget?'],
          },
        });
        deliver
          .mockImplementationOnce(async (_task, _text, attemptId) =>
            finalChannelDelivery('qa-channel', 'rejected', attemptId),
          )
          .mockImplementationOnce(async (_task, _text, attemptId) =>
            finalChannelDelivery('qa-channel', 'accepted', attemptId),
          );
        expect((await executeTask(deps, id)).outcome).toBe('needs_attention');
        const before = await readTask(id);
        const messagesBefore = (await messages()).length;
        const noticesBefore = notify.mock.calls.length;
        expect(await persistence.tasks.wakeTask(id)).not.toBeNull();
        if (crashAfterAcceptance)
          vi.spyOn(persistence.tasks, 'markTaskNeedsAttention').mockResolvedValueOnce(false);
        let retry = await executeTask(deps, id);
        if (crashAfterAcceptance) {
          expect(retry.outcome).toBe('not_claimable');
          expect((await readTask(id)).status).toBe('running');
          await store.doc('tasks', id).update({ lockedUntil: new Date(clock.getTime() - 1) });
          retry = await executeTask(deps, id);
        }
        const restored = await readTask(id);
        expect(retry.outcome).toBe('needs_attention');
        expect(restored.status).toBe('needs_attention');
        expect(restored.progress).toContain('blocked on owner input:');
        expect(restored.progress).not.toContain('delivery was rejected');
        expect(restored.attentionNotifiedAt).toBeTruthy();
        expect((restored.state as { pendingFinal?: unknown }).pendingFinal).toMatchObject({
          terminalStatus: 'needs_attention',
          outcome: 'needs_attention',
          progress: restored.progress,
          deliveryNeedsAttention: false,
          preDeliveryCompletion: {
            terminalStatus: 'needs_attention',
            outcome: 'needs_attention',
            progress: restored.progress,
          },
        });
        expect((await messages()).length).toBe(messagesBefore);
        expect(notify).toHaveBeenCalledTimes(noticesBefore);
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(step).not.toHaveBeenCalled();
        expect((await store.doc('goals', goalId).get()).get('nextAction')).toContain(
          'Waiting on the owner:',
        );
        expect(await tick()).toEqual([]);
        expect(before.progress).toContain('delivery was rejected');
      },
    );

    it('Stop during final existence lookup prevents a dashboard append that has not started', async () => {
      const original = persistence.executionEvidence.finalMessageExists.bind(
        persistence.executionEvidence,
      );
      vi.spyOn(persistence.executionEvidence, 'finalMessageExists').mockImplementationOnce(
        async (input) => {
          const exists = await original(input);
          await mutations.setStatus(goalId, 'abandoned');
          return exists;
        },
      );
      const append = vi.spyOn(persistence.messages, 'append');
      const stopped = await fire([
        tool('qa.inspect'),
        final('Cedar has a confirmed accessible entrance.'),
      ]);
      expect(stopped.result.outcome).toBe('not_claimable');
      expect((await readTask(stopped.id)).status).toBe('cancelled');
      expect((await readTask(stopped.id)).leaseToken).toBeNull();
      expect(append).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
      expect(
        (await messages()).some(
          (message) =>
            message.taskId === stopped.id &&
            message.text === 'Cedar has a confirmed accessible entrance.',
        ),
      ).toBe(false);
      expect(await tick()).toEqual([]);
    });

    it('does not resend an acknowledged delivery after a crash before terminal completion', async () => {
      deliver.mockImplementation(async (_task, _text, attemptId) =>
        finalChannelDelivery('qa-channel', 'accepted', attemptId),
      );
      vi.spyOn(persistence.tasks, 'completeTask').mockResolvedValueOnce(false);
      const first = await fire([tool('qa.inspect'), final('Cedar has confirmed accessibility.')]);
      expect(first.result.outcome).toBe('not_claimable');
      expect((await readTask(first.id)).status).toBe('running');
      const count = (await messages()).length;
      const steps = step.mock.calls.length;
      await store.doc('tasks', first.id).update({ lockedUntil: new Date(clock.getTime() - 1) });
      expect((await executeTask(deps, first.id)).outcome).toBe('done');
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(step).toHaveBeenCalledTimes(steps);
      expect((await messages()).length).toBe(count);
    });

    it('does not treat an empty unchecked session as successful silence', async () => {
      const unchecked = await fire([final(''), final('')]);
      expect(unchecked.result.outcome).toBe('needs_attention');
      expect((await readTask(unchecked.id)).state).not.toMatchObject({
        pendingFinal: { completionKind: 'successful_silent' },
      });
    });

    it.each(['tool', 'final'] as const)(
      'Stop cancels queued work and blocks a running %s',
      async (boundary) => {
        const queued = await tick();
        expect(queued).toHaveLength(1);
        const queuedId = queued[0]?.taskId;
        if (!queuedId) throw new Error('Missing queued fixture task');
        await mutations.setStatus(goalId, 'abandoned');
        expect((await readTask(queuedId)).status).toBe('cancelled');
        expect((await executeTask(deps, queuedId)).outcome).toBe('not_claimable');
        expect(await tick()).toEqual([]);
        expect(step).not.toHaveBeenCalled();

        await mutations.setStatus(goalId, 'active');
        await tick(); // Reinitialize the resumed schedule's next occurrence.
        onStep = async () => {
          await mutations.setStatus(goalId, 'abandoned');
        };
        const running = await fire([
          boundary === 'tool'
            ? tool('qa.prepare', { revision: 1, choice: 'Should never run' })
            : final('This must never be delivered.'),
        ]);
        expect(running.result).toMatchObject({
          outcome: 'not_claimable',
          detail: 'task lease was cancelled, expired, or reclaimed',
        });
        expect((await readTask(running.id)).status).toBe('cancelled');
        expect((await readTask(running.id)).leaseToken).toBeNull();
        expect((await store.collection('qaArtifacts').get()).empty).toBe(true);
        expect(deliver).not.toHaveBeenCalled();
        expect(await tick()).toEqual([]);
      },
    );

    it('retains an already-started local effect after Stop, but runs no later step or delivery', async () => {
      onPrepare = async () => {
        await mutations.setStatus(goalId, 'abandoned');
      };
      const stopped = await fire([tool('qa.prepare', { revision: 1, choice: 'Cedar' })]);
      expect(stopped.result.outcome).toBe('not_claimable');
      expect((await readTask(stopped.id)).status).toBe('cancelled');
      expect((await readTask(stopped.id)).progress).toContain(
        'already-started actions may have completed',
      );
      expect((await store.doc('qaArtifacts', 'comparison').get()).get('choice')).toBe('Cedar');
      expect(step).toHaveBeenCalledTimes(1);
      expect(deliver).not.toHaveBeenCalled();
      expect(await tick()).toEqual([]);
    });

    it.each(['unknown', 'rejected'] as const)(
      'preserves a frozen %s delivery across an owner retry',
      async (status) => {
        deliver.mockImplementation(async (_task, _text, attemptId) =>
          finalChannelDelivery('qa-channel', status, attemptId),
        );
        const first = await fire([
          tool('qa.inspect'),
          final('Cedar has a confirmed accessible entrance.'),
        ]);
        expect(first.result.outcome).toBe('needs_attention');
        expect(deliver).toHaveBeenCalledTimes(1);
        const before = (await readTask(first.id)).state;
        expect(await persistence.tasks.wakeTask(first.id)).not.toBeNull();
        expect((await readTask(first.id)).state).toEqual(before);
        deliver.mockImplementation(async (_task, _text, attemptId) =>
          finalChannelDelivery('qa-channel', 'accepted', attemptId),
        );
        const count = (await messages()).length;
        const modelSteps = step.mock.calls.length;
        const retry = await executeTask(deps, first.id);
        expect(step).toHaveBeenCalledTimes(modelSteps);
        expect((await messages()).length).toBe(count);
        expect(deliver).toHaveBeenCalledTimes(status === 'unknown' ? 1 : 2);
        expect(retry.outcome).toBe(status === 'unknown' ? 'needs_attention' : 'done');
        // Acknowledged or ambiguous sends must not be dispatched again by a sweep/reclaim.
        expect((await executeTask(deps, first.id)).outcome).toBe('not_claimable');
      },
    );
  },
);
