import { randomUUID } from 'node:crypto';
import {
  approvals,
  conversations,
  createDb,
  type Db,
  messages,
  tasks,
  toolCalls,
} from '@assistant/db';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getAgent } from '../chat.js';
import { TaskStateSchema } from '../events.js';
import type { ModelRouter } from '../model-router/router.js';
import { taskBoundCorrectionReadRequest } from './checklist-correction-resume.js';
import { executeTask } from './executor.js';
import { latestOwnerIntent } from './owner-intent.js';
import { buildReadToolInput } from './read-intent.js';
import { buildRequestChecklist, revisePendingRequestChecklistItem } from './request-checklist.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant';
let db: Db;
let agentId: string;
let agentTimeZone = 'UTC';
let ready = false;
const taskIds: string[] = [];
const conversationIds: string[] = [];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  try {
    const agent = await getAgent(db);
    agentId = agent.id;
    agentTimeZone = agent.timezone;
    ready = true;
  } catch {
    console.warn('checklist correction executor: database unreachable — skipping');
  }
});

afterAll(async () => {
  if (ready && taskIds.length) {
    await db.delete(approvals).where(inArray(approvals.taskId, taskIds));
    await db.delete(messages).where(inArray(messages.taskId, taskIds));
    await db.delete(toolCalls).where(inArray(toolCalls.taskId, taskIds));
    await db.delete(tasks).where(inArray(tasks.id, taskIds));
  }
  if (ready && conversationIds.length) {
    await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
    await db.delete(conversations).where(inArray(conversations.id, conversationIds));
  }
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client?.end?.();
});

describe('checklist correction executor over PostgreSQL', () => {
  it.each([
    { name: 'missing watermark', watermark: 'missing' as const },
    { name: 'stale present watermark', watermark: 'present' as const },
    { name: 'invalid revision audit', watermark: 'missing' as const, invalidAudit: true },
    {
      name: 'later unrelated owner message',
      watermark: 'missing' as const,
      laterOwnerMessage: true,
    },
    { name: 'mixed lookup and send outcomes', watermark: 'missing' as const, mixedAction: true },
    { name: 'completed sibling', watermark: 'missing' as const, completedSibling: true },
    {
      name: 'failed then successful bounded read',
      watermark: 'missing' as const,
      failedThenSucceeded: true,
    },
    {
      name: 'relative date anchored to correction message',
      watermark: 'missing' as const,
      relativeCorrectionDate: true,
    },
    {
      name: 'settled corrected read after restart',
      watermark: 'missing' as const,
      restartAfterSelectedCompletion: true,
    },
    {
      name: 'three item restart after two revised lookups completed',
      watermark: 'missing' as const,
      restartAfterTwoCompleted: true,
    },
    {
      name: 'staged corrected final after delivery retry',
      watermark: 'missing' as const,
      restartAfterSelectedCompletion: true,
      retryPendingFinal: true,
      completedSibling: true,
    },
    {
      name: 'staged blocked correction final after delivery retry',
      watermark: 'missing' as const,
      retryBlockedFinal: true,
      completedSibling: true,
    },
    {
      name: 'queued corrected read after restart',
      watermark: 'missing' as const,
      restartBatchStatus: 'queued' as const,
    },
    {
      name: 'budgeted corrected read after restart',
      watermark: 'missing' as const,
      restartBatchStatus: 'budget' as const,
    },
    { name: 'mixed correction journal', watermark: 'missing' as const, malformedBatch: true },
  ])(
    'handles $name without calling the planner',
    async ({
      watermark,
      invalidAudit,
      laterOwnerMessage,
      mixedAction,
      completedSibling,
      restartAfterSelectedCompletion,
      restartAfterTwoCompleted,
      restartBatchStatus,
      malformedBatch,
      retryPendingFinal,
      failedThenSucceeded,
      relativeCorrectionDate,
      retryBlockedFinal,
    }) => {
      if (!ready) return;
      const [conversation] = await db
        .insert(conversations)
        .values({ agentId, channel: 'chat', trust: 'owner' })
        .returning();
      if (!conversation) throw new Error('conversation insert failed');
      conversationIds.push(conversation.id);

      const originalText = restartAfterTwoCompleted
        ? 'Find my hotel confirmation email in Berlin and find my flight confirmation email to Paris on 2026-12-21 and find my museum reservation in Rome'
        : mixedAction
          ? 'Find my flight confirmation email to Paris on 2026-12-21 and send an email to Alice'
          : 'Find my hotel confirmation email in Berlin and find my flight confirmation email to Paris on 2026-12-21';
      const correctionText = relativeCorrectionDate
        ? 'Find my flight to London tomorrow'
        : 'Find my flight confirmation email to London on 2026-12-21';
      const originalMessageId = randomUUID();
      const correctionMessageId = randomUUID();
      const { task } = await import('./machine.js').then(({ enqueueTask }) =>
        enqueueTask(db, {
          event: {
            source: 'chat',
            agentId,
            conversationId: conversation.id,
            trust: 'owner',
            payload: { text: originalText, triggerMessageId: originalMessageId },
          },
          type: 'chat_turn',
          deferNotification: true,
        }),
      );
      taskIds.push(task.id);

      const initial = buildRequestChecklist(originalText);
      if (!initial || initial.items.length < 2)
        throw new Error('compound request checklist missing');
      const completedSiblingReceipt = completedSibling
        ? {
            id: randomUUID(),
            taskId: task.id,
            toolName: 'gmail.search',
            args: { query: 'hotel berlin' },
            risk: 'autonomous' as const,
            status: 'succeeded' as const,
            result: {
              results: [{ threadId: 'old-berlin-hotel', subject: 'Berlin hotel confirmation' }],
            },
            step: 0,
            decision: { model: 'synthetic-prior' },
            finishedAt: new Date(),
          }
        : undefined;
      if (completedSiblingReceipt) {
        await db.insert(toolCalls).values(completedSiblingReceipt);
      }
      const baseChecklist = completedSibling
        ? {
            ...initial,
            items: initial.items.map((item, index) =>
              index === 0
                ? {
                    ...item,
                    status: 'completed' as const,
                    evidence: [{ id: completedSiblingReceipt?.id ?? '', toolName: 'gmail.search' }],
                  }
                : item,
            ),
          }
        : initial;
      const ownerMessage = {
        id: correctionMessageId,
        taskId: task.id,
        agentId,
        conversationId: conversation.id,
        role: 'user' as const,
        origin: 'owner' as const,
        text: correctionText,
      };
      const correctedItemIndex = initial.items.findIndex((item) =>
        item.label.toLowerCase().includes('flight'),
      );
      const corrected = revisePendingRequestChecklistItem(baseChecklist, {
        task: { id: task.id, agentId, conversationId: conversation.id },
        ownerMessage,
        binding: {
          taskId: task.id,
          itemId: baseChecklist.items[correctedItemIndex]?.id ?? '',
          expectedRevision: 0,
          ownerTaskId: task.id,
          ownerMessageId: correctionMessageId,
        },
        evidence: {
          complete: true,
          rows: completedSiblingReceipt
            ? [{ ...completedSiblingReceipt, effectOutcome: 'completed' as const }]
            : [],
        },
        replacement: { kind: 'lookup', label: correctionText },
      });
      expect(corrected.revision).toBe(1);
      const ownerIntent = latestOwnerIntent([{ role: 'user', content: originalText }], {
        trust: 'owner',
        trigger: { source: 'chat', payload: { text: originalText } },
      });
      expect(ownerIntent.authorizedScopes).toContain('private_read');
      expect(
        taskBoundCorrectionReadRequest(correctionText, {
          now: task.createdAt,
          timeZone: 'America/Los_Angeles',
          authorizedScopes: ownerIntent.authorizedScopes,
        }),
      ).toBeDefined();

      const settledCorrectionReceiptId =
        restartAfterSelectedCompletion || restartAfterTwoCompleted ? randomUUID() : undefined;
      const failedCorrectionReceiptId =
        retryPendingFinal || failedThenSucceeded ? randomUUID() : undefined;
      const flightOutcomeId = corrected.items[correctedItemIndex]?.id;
      const hotelOutcomeId = corrected.items.find((item) =>
        item.label.toLowerCase().includes('hotel'),
      )?.id;
      const flightReadRequest = taskBoundCorrectionReadRequest(correctionText, {
        now: new Date('2019-01-01T00:00:00Z'),
        timeZone: agentTimeZone,
        authorizedScopes: ownerIntent.authorizedScopes,
      });
      const flightReadArgs = flightReadRequest
        ? buildReadToolInput(flightReadRequest, 'calendar.search_events', [])
        : null;
      const failedReadArgs = flightReadRequest
        ? buildReadToolInput(flightReadRequest, 'gmail.search', [])
        : null;
      if (
        (restartAfterSelectedCompletion || restartAfterTwoCompleted) &&
        (!flightOutcomeId || !flightReadArgs || !settledCorrectionReceiptId)
      )
        throw new Error(
          'settled correction receipt fixture could not bind to the corrected lookup',
        );
      const settledCorrectionReceipt =
        restartAfterSelectedCompletion || restartAfterTwoCompleted
          ? {
              id: settledCorrectionReceiptId as string,
              taskId: task.id,
              toolName: 'calendar.search_events',
              args: flightReadArgs as Record<string, unknown>,
              risk: 'autonomous' as const,
              status: 'succeeded' as const,
              result: {
                events: [
                  {
                    id: 'flight-london',
                    summary: 'London flight',
                    start: '2026-12-21T08:00:00Z',
                    end: '2026-12-21T09:00:00Z',
                  },
                ],
              },
              step: 1,
              decision: {
                model: 'runtime/private-read-router',
                modelToolCallId: `runtime-private-read-${task.id}-1`,
                checklistCorrection: {
                  revision: 1,
                  outcomeId: flightOutcomeId as string,
                  ownerMessageId: correctionMessageId,
                },
              },
              finishedAt: new Date(),
            }
          : undefined;
      const failedCorrectionReceipt =
        retryPendingFinal || failedThenSucceeded
          ? {
              id: failedCorrectionReceiptId as string,
              taskId: task.id,
              toolName: 'gmail.search',
              args: failedReadArgs as Record<string, unknown>,
              risk: 'autonomous' as const,
              status: 'failed' as const,
              error: 'synthetic preflight failure; no provider read was sent',
              step: 0,
              decision: {
                model: 'runtime/private-read-router',
                modelToolCallId: `runtime-private-read-${task.id}-0`,
                checklistCorrection: {
                  revision: 1,
                  outcomeId: flightOutcomeId as string,
                  ownerMessageId: correctionMessageId,
                },
              },
              finishedAt: new Date(),
            }
          : undefined;
      if (settledCorrectionReceipt) await db.insert(toolCalls).values(settledCorrectionReceipt);
      if (failedCorrectionReceipt) await db.insert(toolCalls).values(failedCorrectionReceipt);
      const settledHotelReceiptId = restartAfterTwoCompleted ? randomUUID() : undefined;
      const settledHotelReceipt = restartAfterTwoCompleted
        ? {
            id: settledHotelReceiptId as string,
            taskId: task.id,
            toolName: 'gmail.search',
            args: { query: 'Berlin hotel' },
            risk: 'autonomous' as const,
            status: 'succeeded' as const,
            result: {
              results: [{ threadId: 'current-berlin-hotel', subject: 'Berlin hotel confirmation' }],
            },
            step: 2,
            decision: {
              model: 'runtime/private-read-router',
              modelToolCallId: `runtime-private-read-${task.id}-2`,
              checklistCorrection: {
                revision: 1,
                outcomeId: hotelOutcomeId as string,
                ownerMessageId: correctionMessageId,
              },
            },
            finishedAt: new Date(),
          }
        : undefined;
      if (settledHotelReceipt) await db.insert(toolCalls).values(settledHotelReceipt);
      const basePersistedChecklist = invalidAudit
        ? { ...corrected, revisionAudit: [] }
        : retryBlockedFinal
          ? {
              ...corrected,
              items: corrected.items.map((item) =>
                item.id === flightOutcomeId
                  ? {
                      ...item,
                      status: 'blocked' as const,
                      evidence: [],
                      detail: 'The corrected flight lookup needs attention.',
                    }
                  : item,
              ),
            }
          : restartAfterSelectedCompletion || restartAfterTwoCompleted
            ? {
                ...corrected,
                items: corrected.items.map((item) =>
                  item.id === flightOutcomeId ||
                  (restartAfterTwoCompleted && item.id === hotelOutcomeId)
                    ? {
                        ...item,
                        status: 'completed' as const,
                        evidence:
                          item.id === flightOutcomeId
                            ? [
                                {
                                  id: settledCorrectionReceiptId as string,
                                  toolName: 'calendar.search_events',
                                },
                              ]
                            : [{ id: settledHotelReceiptId as string, toolName: 'gmail.search' }],
                        detail:
                          item.id === flightOutcomeId
                            ? 'London flight: Flight found for 2026-12-21.'
                            : 'Berlin hotel confirmation found.',
                      }
                    : item,
                ),
              }
            : corrected;
      const persistedChecklist = retryPendingFinal
        ? {
            ...basePersistedChecklist,
            items: basePersistedChecklist.items.map((item) =>
              item.status === 'completed' ? item : { ...item, status: 'blocked' as const },
            ),
          }
        : basePersistedChecklist;

      await db.insert(messages).values([
        {
          id: originalMessageId,
          taskId: task.id,
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          text: originalText,
          createdAt: new Date('2020-01-01T00:00:00Z'),
        },
        {
          id: correctionMessageId,
          taskId: task.id,
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          text: correctionText,
          createdAt: new Date('2019-01-01T00:00:00Z'),
        },
      ]);
      const savedBatch =
        restartAfterSelectedCompletion ||
        restartAfterTwoCompleted ||
        restartBatchStatus ||
        malformedBatch
          ? {
              step: restartAfterTwoCompleted ? 2 : 1,
              modelId: 'runtime/private-read-router',
              calls: malformedBatch
                ? [
                    {
                      toolCallId: `runtime-private-read-${task.id}-1`,
                      toolName: 'calendar.search_events',
                      input: flightReadArgs as Record<string, unknown>,
                      status: 'queued' as const,
                    },
                    {
                      toolCallId: `foreign-call-${task.id}-1`,
                      toolName: 'gmail.search',
                      input: { query: 'unbound' },
                      status: 'queued' as const,
                    },
                  ]
                : [
                    {
                      toolCallId: `runtime-private-read-${task.id}-${restartAfterTwoCompleted ? 2 : 1}`,
                      toolName: restartAfterTwoCompleted
                        ? 'gmail.search'
                        : 'calendar.search_events',
                      input: (restartAfterTwoCompleted
                        ? settledHotelReceipt?.args
                        : flightReadArgs) as Record<string, unknown>,
                      status:
                        restartAfterSelectedCompletion || restartAfterTwoCompleted
                          ? ('settled' as const)
                          : (restartBatchStatus as 'queued' | 'budget'),
                      ...(restartAfterTwoCompleted
                        ? { dbToolCallId: settledHotelReceiptId as string }
                        : restartAfterSelectedCompletion
                          ? { dbToolCallId: settledCorrectionReceiptId as string }
                          : {}),
                    },
                  ],
            }
          : undefined;
      await db
        .update(tasks)
        .set({
          plan: {
            action: 'workflow',
            reasoning: 'stale prior target Paris',
            steps: ['search Paris flight'],
            missingInfo: [],
          },
          maxSteps: 8,
          state: TaskStateSchema.parse({
            requestChecklist: persistedChecklist,
            contextWindow: [{ role: 'assistant', content: 'Old plan: search Paris flight' }],
            seenConversationAt:
              watermark === 'present' ? new Date('2026-10-10T12:00:00Z').toISOString() : null,
            plannerState: { oldTarget: 'Paris' },
            ...(savedBatch
              ? { pendingToolBatch: savedBatch, step: restartAfterTwoCompleted ? 2 : 1 }
              : {}),
            ...(retryPendingFinal || retryBlockedFinal
              ? {
                  pendingFinal: {
                    text: retryBlockedFinal
                      ? 'Berlin hotel confirmation found.\n\nThe corrected flight lookup needs attention.'
                      : 'Berlin hotel confirmation found.\n\nLondon flight: Flight found for 2026-12-21.',
                    progress: retryBlockedFinal
                      ? 'one lookup completed; one needs attention'
                      : 'corrected lookups completed',
                    terminalStatus: retryBlockedFinal
                      ? ('needs_attention' as const)
                      : ('done' as const),
                    outcome: retryBlockedFinal ? ('needs_attention' as const) : ('done' as const),
                    checklistCorrection: {
                      revision: 1,
                      ownerMessageId: correctionMessageId,
                      outcomes: [
                        ...persistedChecklist.items
                          .filter(
                            (item) => item.status === 'completed' || item.status === 'blocked',
                          )
                          .map((item) => ({
                            id: item.id,
                            status: item.status as 'completed' | 'blocked',
                            evidenceIds:
                              item.status === 'completed'
                                ? item.evidence
                                    .map((entry) => entry.id)
                                    .slice(-256)
                                    .sort()
                                : [],
                          })),
                      ],
                    },
                  },
                }
              : {}),
          }),
        })
        .where(eq(tasks.id, task.id));
      if (laterOwnerMessage) {
        await db.insert(messages).values({
          conversationId: conversation.id,
          role: 'user',
          origin: 'owner',
          text: 'Now look for a restaurant in Madrid',
        });
      }

      const dispatched: Array<{
        toolName: string;
        args: Record<string, unknown>;
        decision?: Record<string, unknown>;
      }> = [];
      const router = {
        step: vi.fn(async () => {
          throw new Error('correction lane must not call the model');
        }),
        object: vi.fn(async () => {
          throw new Error('correction lane must not call the planner');
        }),
        embed: vi.fn(async (values: string[]) => values.map(() => new Array(1536).fill(0))),
      } as unknown as ModelRouter;
      const toolDefs = vi.fn(() => [
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
      ]);
      const dispatcher = {
        toolDefs,
        resultIsUntrusted: () => false,
        dispatch: async (input: {
          task: { id: string };
          step: number;
          modelToolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
          provenance: Record<string, unknown>;
        }) => {
          dispatched.push({
            toolName: input.toolName,
            args: input.args,
            decision: input.provenance,
          });
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
                      { threadId: `thread-${dispatched.length}`, subject: query, snippet: query },
                    ],
                  }
                : { messages: [{ subject: query, text: query }] };
          const [row] = await db
            .insert(toolCalls)
            .values({
              taskId: input.task.id,
              toolName: input.toolName,
              args: input.args,
              risk: 'autonomous',
              status: 'succeeded',
              result,
              step: input.step,
              decision: { ...input.provenance, modelToolCallId: input.modelToolCallId },
              finishedAt: new Date(),
            })
            .returning({ id: toolCalls.id });
          if (!row) throw new Error('synthetic dispatcher failed to persist its receipt');
          return { kind: 'executed' as const, toolCallId: row.id, result, cached: false };
        },
        executeApproved: vi.fn(async () => ({ kind: 'failed' as const, error: 'unused' })),
      };

      const executionResult = await executeTask({ db, router, dispatcher }, task.id);
      const [finishedTask] = await db.select().from(tasks).where(eq(tasks.id, task.id));

      expect(router.object).not.toHaveBeenCalled();
      expect(router.step).not.toHaveBeenCalled();
      if (retryPendingFinal || retryBlockedFinal) {
        expect(dispatched).toHaveLength(0);
        expect(executionResult.outcome).toBe(retryBlockedFinal ? 'needs_attention' : 'done');
        const delivered = await db
          .select({ text: messages.text })
          .from(messages)
          .where(eq(messages.taskId, task.id));
        if (retryPendingFinal)
          expect(
            delivered.some((message) =>
              message.text.includes('London flight: Flight found for 2026-12-21.'),
            ),
          ).toBe(true);
        if (retryBlockedFinal)
          expect(
            delivered.some((message) =>
              message.text.includes('The corrected flight lookup needs attention.'),
            ),
          ).toBe(true);
        expect(
          delivered.some((message) => message.text.includes('Berlin hotel confirmation found.')),
        ).toBe(true);
        if (retryPendingFinal) {
          const correctionReceipts = await db
            .select({ id: toolCalls.id, status: toolCalls.status })
            .from(toolCalls)
            .where(eq(toolCalls.taskId, task.id));
          expect(correctionReceipts).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: failedCorrectionReceiptId,
                status: 'failed',
              }),
              expect.objectContaining({
                id: settledCorrectionReceiptId,
                status: 'succeeded',
              }),
            ]),
          );
        }
        return;
      }
      const finalText = (finishedTask?.state as { pendingFinal?: { text?: string } })?.pendingFinal
        ?.text;
      if (invalidAudit || laterOwnerMessage || mixedAction || malformedBatch) {
        expect(dispatched).toHaveLength(0);
        expect(executionResult.outcome).toBe('needs_attention');
        return;
      }
      expect(
        dispatched.length,
        `${executionResult.outcome}: ${finishedTask?.progress}; ${finalText}; maxSteps=${finishedTask?.maxSteps} stateStep=${(finishedTask?.state as { step?: number } | undefined)?.step}; toolDefs=${JSON.stringify(toolDefs.mock.calls)}`,
      ).toBeGreaterThan(0);
      if (restartAfterTwoCompleted) {
        expect(
          dispatched.some(
            (call) =>
              call.toolName === 'calendar.search_events' &&
              String(call.args.query).toLowerCase().includes('london'),
          ),
        ).toBe(false);
        expect(
          dispatched.some((call) => String(call.args.query).toLowerCase().includes('hotel')),
        ).toBe(false);
        expect(
          dispatched.some((call) => String(call.args.query).toLowerCase().includes('museum')),
        ).toBe(true);
        expect(finalText).toContain('London flight');
        expect(finalText).toContain('Berlin hotel confirmation found.');
        expect(finalText).toContain('museum');
      } else if (restartAfterSelectedCompletion) {
        expect(
          dispatched.some(
            (call) =>
              call.toolName === 'calendar.search_events' &&
              String(call.args.query).toLowerCase().includes('london'),
          ),
        ).toBe(false);
        expect(
          dispatched.filter((call) => String(call.args.query).toLowerCase().includes('hotel')),
        ).toHaveLength(1);
        expect(finalText).toContain('London flight');
        expect(finalText).toContain('Find my hotel confirmation email in Berlin');
      } else {
        expect(dispatched[0]?.toolName).toBe('calendar.search_events');
        expect(String(dispatched[0]?.args.query).toLowerCase()).toContain('london');
        expect(String(dispatched[0]?.args.query).toLowerCase()).not.toContain('paris');
      }
      if (relativeCorrectionDate) {
        expect(dispatched[0]?.args.timeMin).toBe('2019-01-02T00:00:00.000Z');
        expect(dispatched[0]?.args.timeMin).not.toBe((task.createdAt as Date).toISOString());
      }
      if (failedThenSucceeded) {
        expect(
          dispatched.filter((call) => call.toolName === 'calendar.search_events'),
        ).toHaveLength(1);
        const afterTask = finishedTask?.state as {
          requestChecklist?: {
            items?: Array<{ id: string; label: string; evidence: Array<{ id: string }> }>;
          };
        };
        const correctedFlight = afterTask.requestChecklist?.items?.find((item) =>
          item.label.toLowerCase().includes('flight'),
        );
        const attemptRows = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
        expect(
          attemptRows.some(
            (row) => row.id === failedCorrectionReceiptId && row.status === 'failed',
          ),
        ).toBe(true);
        expect(correctedFlight?.evidence.map((item) => item.id)).not.toContain(
          failedCorrectionReceiptId,
        );
        for (const receipt of correctedFlight?.evidence ?? []) {
          expect(attemptRows.find((row) => row.id === receipt.id)?.status).toBe('succeeded');
        }
      }
      const siblingQuery = dispatched.find((call) =>
        String(call.args.query).toLowerCase().includes('hotel'),
      );
      if (completedSibling || restartAfterTwoCompleted) {
        expect(siblingQuery).toBeUndefined();
      } else {
        expect(
          siblingQuery,
          JSON.stringify({
            dispatched,
            executionResult,
            progress: finishedTask?.progress,
            status: finishedTask?.status,
            finalText,
            maxSteps: finishedTask?.maxSteps,
            step: (finishedTask?.state as { step?: number })?.step,
            items: (finishedTask?.state as { requestChecklist?: { items?: unknown[] } })
              ?.requestChecklist?.items,
          }),
        ).toBeDefined();
        expect(String(siblingQuery?.args.query).toLowerCase()).not.toContain('london');
      }
      const persistedCalls = await db.select().from(toolCalls).where(eq(toolCalls.taskId, task.id));
      expect(
        new Set(
          persistedCalls
            .map(
              (call) =>
                (call.decision as { checklistCorrection?: { outcomeId?: string } })
                  .checklistCorrection?.outcomeId,
            )
            .filter((id): id is string => Boolean(id)),
        ),
      ).toEqual(
        new Set(
          corrected.items
            .filter(
              (item) =>
                item.status === 'pending' ||
                ((restartAfterSelectedCompletion || restartAfterTwoCompleted) &&
                  (item.id === flightOutcomeId ||
                    (restartAfterTwoCompleted && item.id === hotelOutcomeId))),
            )
            .map((item) => item.id),
        ),
      );
    },
    30_000,
  );
});
