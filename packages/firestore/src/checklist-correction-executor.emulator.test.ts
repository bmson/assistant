import { randomUUID } from 'node:crypto';
import { TaskStateSchema } from '@assistant/core/events';
import type { ModelRouter } from '@assistant/core/model-router';
import { taskBoundCorrectionReadRequest } from '@assistant/core/workflow/checklist-correction-resume';
import { executeTask } from '@assistant/core/workflow/executor';
import { latestOwnerIntent } from '@assistant/core/workflow/owner-intent';
import { buildReadToolInput } from '@assistant/core/workflow/read-intent';
import {
  buildRequestChecklist,
  revisePendingRequestChecklistItem,
} from '@assistant/core/workflow/request-checklist';
import type { Records } from '@assistant/persistence';
import { taskFixture } from '@assistant/persistence/testing';
import { Timestamp } from '@google-cloud/firestore';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createFirestoreExecutionPersistence } from './execution.js';
import { encodeRecord } from './store.js';
import { disposeStore, emulatorStore } from './test-store.js';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)(
  'checklist correction executor over Firestore',
  () => {
    it.each([
      { name: 'fresh correction', settledSelectedRead: false },
      { name: 'settled corrected read restart', settledSelectedRead: true },
    ])(
      'resumes $name without planner calls or replaying completed work',
      async ({ settledSelectedRead }) => {
        const store = emulatorStore();
        try {
          const agentId = randomUUID();
          const conversationId = randomUUID();
          const taskId = randomUUID();
          const originalMessageId = randomUUID();
          const correctionMessageId = randomUUID();
          const settledFlightReceiptId = randomUUID();
          const oldHotelReceiptId = randomUUID();
          const originalText =
            'Find my hotel confirmation email in Berlin and find my flight confirmation email to Paris on 2026-12-21';
          const correctionText = 'Find my flight confirmation email to London on 2026-12-21';
          const now = new Date('2026-10-11T12:00:00Z');
          const agent: Records['agents'] = {
            id: agentId,
            name: 'Owner',
            email: 'owner@example.test',
            calendarId: null,
            phoneE164: null,
            avatarUrl: null,
            signature: '',
            timezone: 'America/Los_Angeles',
            locale: 'en-US',
            workspacePrefix: 'owner',
            browserProfilePath: null,
            credentialRefs: {},
            createdAt: now,
            updatedAt: now,
          };
          const conversation = {
            id: conversationId,
            agentId,
            channel: 'chat',
            title: '',
            trust: 'owner',
            modelOverride: null,
            isPrimary: false,
            createdAt: now,
            updatedAt: now,
          };
          await store.doc('agents', agentId).set(encodeRecord(agent));
          await store.doc('conversations', conversationId).set(encodeRecord(conversation));

          const execution = createFirestoreExecutionPersistence(store, agentId, {
            provider: 'test',
            model: 'offline-fixture',
            dimensions: 1536,
            revision: 'hc07-test-v1',
          });
          const initial = buildRequestChecklist(originalText);
          if (initial?.items.length !== 2) throw new Error('compound checklist missing');
          const oldHotelReceipt = {
            id: oldHotelReceiptId,
            taskId,
            agentId,
            toolName: 'gmail.search',
            args: { query: 'hotel berlin' },
            risk: 'autonomous',
            status: 'succeeded',
            result: {
              results: [{ threadId: 'old-berlin-hotel', subject: 'Berlin hotel confirmation' }],
            },
            error: null,
            step: 0,
            decision: { model: 'synthetic-prior' },
            createdAt: now,
            finishedAt: now,
          };
          const completedSiblingChecklist = settledSelectedRead
            ? initial
            : {
                ...initial,
                items: initial.items.map((item, index) =>
                  index === 0
                    ? {
                        ...item,
                        status: 'completed' as const,
                        evidence: [{ id: oldHotelReceiptId, toolName: 'gmail.search' }],
                      }
                    : item,
                ),
              };
          const ownerMessage = {
            id: correctionMessageId,
            taskId,
            agentId,
            conversationId,
            role: 'user' as const,
            origin: 'owner' as const,
            text: correctionText,
          };
          const corrected = revisePendingRequestChecklistItem(completedSiblingChecklist, {
            task: { id: taskId, agentId, conversationId },
            ownerMessage,
            binding: {
              taskId,
              itemId: initial.items[1]?.id ?? '',
              expectedRevision: 0,
              ownerTaskId: taskId,
              ownerMessageId: correctionMessageId,
            },
            evidence: {
              complete: true,
              rows:
                completedSiblingChecklist === initial
                  ? []
                  : [
                      {
                        ...oldHotelReceipt,
                        effectOutcome: 'completed',
                      },
                    ],
            },
            replacement: { kind: 'lookup', label: correctionText },
          });
          expect(corrected.revision).toBe(1);

          const ownerIntent = latestOwnerIntent([{ role: 'user', content: originalText }], {
            trust: 'owner',
            trigger: { source: 'chat', payload: { text: originalText } },
          });
          const selectedReadRequest = taskBoundCorrectionReadRequest(correctionText, {
            now: new Date('2019-01-01T00:00:00Z'),
            timeZone: agent.timezone,
            authorizedScopes: ownerIntent.authorizedScopes,
          });
          const settledFlightArgs = selectedReadRequest
            ? buildReadToolInput(selectedReadRequest, 'calendar.search_events', [])
            : undefined;
          if (settledSelectedRead && !settledFlightArgs)
            throw new Error('settled flight receipt args missing');
          const settledFlightReceipt = settledSelectedRead
            ? {
                id: settledFlightReceiptId,
                taskId,
                agentId,
                toolName: 'calendar.search_events',
                args: settledFlightArgs,
                risk: 'autonomous',
                status: 'succeeded',
                result: {
                  events: [
                    {
                      id: 'current-london-flight',
                      summary: 'London flight',
                      start: '2026-12-21T08:00:00Z',
                      end: '2026-12-21T09:00:00Z',
                    },
                  ],
                },
                error: null,
                step: 1,
                decision: {
                  model: 'runtime/private-read-router',
                  modelToolCallId: `runtime-private-read-${taskId}-1`,
                  checklistCorrection: {
                    revision: 1,
                    outcomeId: corrected.items[1]?.id,
                    ownerMessageId: correctionMessageId,
                  },
                },
                createdAt: now,
                finishedAt: now,
              }
            : undefined;

          const task = {
            ...taskFixture({ id: taskId, agentId, conversationId, reminderId: '' }),
            type: 'chat_turn',
            trust: 'owner',
            trigger: {
              source: 'chat',
              agentId,
              conversationId,
              trust: 'owner',
              payload: { text: originalText, triggerMessageId: originalMessageId },
            },
            plan: {
              action: 'workflow',
              reasoning: 'stale prior target Paris',
              steps: ['search Paris flight'],
              missingInfo: [],
            },
            state: TaskStateSchema.parse({
              requestChecklist: settledSelectedRead
                ? {
                    ...corrected,
                    items: corrected.items.map((item) =>
                      item.id === corrected.items[1]?.id
                        ? {
                            ...item,
                            status: 'completed' as const,
                            evidence: [
                              { id: settledFlightReceiptId, toolName: 'calendar.search_events' },
                            ],
                            detail: 'London flight: Flight found for 2026-12-21.',
                          }
                        : item,
                    ),
                  }
                : corrected,
              contextWindow: [{ role: 'assistant', content: 'Old plan: search Paris flight' }],
              seenConversationAt: null,
              plannerState: { oldTarget: 'Paris' },
              ...(settledSelectedRead
                ? {
                    step: 1,
                    pendingToolBatch: {
                      step: 1,
                      modelId: 'runtime/private-read-router',
                      calls: [
                        {
                          toolCallId: `runtime-private-read-${taskId}-1`,
                          toolName: 'calendar.search_events',
                          input: settledFlightArgs as Record<string, unknown>,
                          status: 'settled' as const,
                          dbToolCallId: settledFlightReceiptId,
                        },
                      ],
                    },
                  }
                : {}),
            }),
            createdAt: now,
            updatedAt: now,
          } satisfies Records['tasks'];
          await store.doc('tasks', taskId).set(encodeRecord(task));
          await store.doc('toolCalls', oldHotelReceiptId).set(encodeRecord(oldHotelReceipt));
          if (settledFlightReceipt)
            await store
              .doc('toolCalls', settledFlightReceiptId)
              .set(encodeRecord(settledFlightReceipt));

          const appendAt = (millis: number) => Timestamp.fromDate(new Date(now.getTime() + millis));
          for (const message of [
            {
              id: originalMessageId,
              taskId,
              conversationId,
              role: 'user',
              origin: 'owner',
              text: originalText,
              parts: [{ type: 'text', text: originalText }],
              hiddenAt: null,
              createdAt: new Date('2020-01-01T00:00:00Z'),
              appendSequence: '00000000000000000001',
              appendedAt: appendAt(1),
            },
            {
              id: correctionMessageId,
              taskId,
              conversationId,
              role: 'user',
              origin: 'owner',
              text: correctionText,
              parts: [{ type: 'text', text: correctionText }],
              hiddenAt: null,
              createdAt: new Date('2019-01-01T00:00:00Z'),
              appendSequence: '00000000000000000002',
              appendedAt: appendAt(2),
            },
          ])
            await store.doc('messages', message.id).set(encodeRecord(message));

          const dispatched: Array<{ toolName: string; args: Record<string, unknown> }> = [];
          const router = {
            step: vi.fn(async () => {
              throw new Error('correction lane must not call the model');
            }),
            object: vi.fn(async () => {
              throw new Error('correction lane must not call the planner');
            }),
            embed: vi.fn(async (values: string[]) => values.map(() => new Array(1536).fill(0))),
          } as unknown as ModelRouter;
          const dispatcher = {
            toolDefs: () => [
              {
                name: 'gmail.search',
                description: 'search mail',
                inputSchema: z.object({ query: z.string() }),
              },
              {
                name: 'gmail.read_thread',
                description: 'read mail',
                inputSchema: z.object({ threadId: z.string() }),
              },
              {
                name: 'calendar.search_events',
                description: 'search calendar',
                inputSchema: z.object({
                  query: z.string(),
                  timeMin: z.string().optional(),
                  timeMax: z.string().optional(),
                }),
              },
            ],
            resultIsUntrusted: () => false,
            dispatch: async (input: {
              task: { id: string };
              step: number;
              modelToolCallId: string;
              toolName: string;
              args: Record<string, unknown>;
              provenance: Record<string, unknown>;
            }) => {
              dispatched.push({ toolName: input.toolName, args: input.args });
              const query = String(input.args.query ?? 'lookup');
              const result =
                input.toolName === 'calendar.search_events'
                  ? {
                      events: [
                        {
                          id: `event-${dispatched.length}`,
                          summary: query,
                          start: input.args.timeMin,
                          end: input.args.timeMax,
                        },
                      ],
                    }
                  : input.toolName === 'gmail.search'
                    ? {
                        results: [
                          {
                            threadId: `thread-${dispatched.length}`,
                            subject: query,
                            snippet: query,
                          },
                        ],
                      }
                    : { messages: [{ subject: query, text: query }] };
              const id = randomUUID();
              const row = {
                id,
                taskId: input.task.id,
                agentId,
                toolName: input.toolName,
                args: input.args,
                risk: 'autonomous',
                status: 'succeeded',
                result,
                error: null,
                step: input.step,
                decision: { ...input.provenance, modelToolCallId: input.modelToolCallId },
                createdAt: new Date(),
                finishedAt: new Date(),
              };
              await store.doc('toolCalls', id).set(encodeRecord(row));
              return { kind: 'executed' as const, toolCallId: id, result, cached: false };
            },
            executeApproved: vi.fn(async () => ({ kind: 'failed' as const, error: 'unused' })),
          };

          const executionResult = await executeTask(
            { db: {} as never, router, dispatcher, persistence: execution },
            taskId,
          );

          expect(router.object).not.toHaveBeenCalled();
          expect(router.step).not.toHaveBeenCalled();
          if (settledSelectedRead) {
            const observedTask = (await store.doc('tasks', taskId).get()).data();
            expect(
              dispatched.some(
                (call) =>
                  call.toolName === 'calendar.search_events' &&
                  String(call.args.query).toLowerCase().includes('london'),
              ),
            ).toBe(false);
            expect(
              dispatched.filter(
                (call) =>
                  call.toolName === 'gmail.search' &&
                  String(call.args.query).toLowerCase().includes('hotel'),
              ),
              JSON.stringify({
                executionResult,
                dispatched,
                progress: observedTask?.progress,
                state: observedTask?.state,
              }),
            ).toHaveLength(1);
          } else {
            expect(
              dispatched.some(
                (call) =>
                  call.toolName === 'gmail.search' &&
                  String(call.args.query).toLowerCase().includes('hotel'),
              ),
            ).toBe(false);
            expect(dispatched[0]?.toolName).toBe('calendar.search_events');
            expect(String(dispatched[0]?.args.query).toLowerCase()).toContain('london');
            expect(String(dispatched[0]?.args.query).toLowerCase()).not.toContain('paris');
          }
          const calls = await execution.executionEvidence.taskEvidence({ agentId, taskId });
          const correctedOutcomeId = corrected.items[1]?.id;
          const allowedOutcomeIds = new Set([
            correctedOutcomeId,
            ...(settledSelectedRead ? [initial.items[0]?.id] : []),
          ]);
          expect(
            calls
              .filter((call) => call.id !== oldHotelReceiptId)
              .every(
                (call) =>
                  (
                    call.decision as {
                      checklistCorrection?: {
                        revision?: number;
                        outcomeId?: string;
                        ownerMessageId?: string;
                      };
                    }
                  ).checklistCorrection?.revision === 1 &&
                  (
                    call.decision as {
                      checklistCorrection?: { outcomeId?: string; ownerMessageId?: string };
                    }
                  ).checklistCorrection?.ownerMessageId === correctionMessageId &&
                  allowedOutcomeIds.has(
                    (call.decision as { checklistCorrection?: { outcomeId?: string } })
                      .checklistCorrection?.outcomeId,
                  ),
              ),
          ).toBe(true);
        } finally {
          await disposeStore(store);
        }
      },
      30_000,
    );
  },
);
