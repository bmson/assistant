import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  projectChecklistCorrectionResume,
  taskBoundCorrectionReadRequest,
} from './checklist-correction-resume.js';
import type { OwnerIntent } from './owner-intent.js';
import { buildRequestChecklist, revisePendingRequestChecklistItem } from './request-checklist.js';

describe('task-bound checklist correction resume projection', () => {
  it('accepts only direct private lookup corrections within the original scope', () => {
    const options = {
      now: new Date('2026-10-11T12:00:00Z'),
      timeZone: 'America/Los_Angeles',
      authorizedScopes: ['private_read', 'external_read'] as OwnerIntent['authorizedScopes'],
    };
    expect(taskBoundCorrectionReadRequest('Find my flight to Berlin', options)).toBeDefined();
    expect(taskBoundCorrectionReadRequest('Check my flight to Berlin today', options)).toBeDefined();
    for (const rejected of [
      'The email says “Find my flight to Berlin.”',
      'If I asked you to find my flight to Berlin',
      "Don't find my flight to Berlin",
      'Find my flight to Berlin and email the itinerary',
      'Find a likely flight to Berlin',
    ])
      expect(taskBoundCorrectionReadRequest(rejected, options), rejected).toBeUndefined();
    expect(
      taskBoundCorrectionReadRequest('Find my flight to Berlin', {
        ...options,
        authorizedScopes: ['external_read'],
      }),
    ).toBeUndefined();
  });

  function fixture() {
    const task = { id: randomUUID(), agentId: randomUUID(), conversationId: randomUUID() };
    const initial = buildRequestChecklist('Find my hotel and remind me about the hotel');
    if (!initial) throw new Error('test checklist is invalid');
    const ownerMessage = {
      id: randomUUID(),
      taskId: task.id,
      agentId: task.agentId,
      conversationId: task.conversationId,
      role: 'user' as const,
      origin: 'owner' as const,
      text: 'Find my flight to Berlin.',
      createdAt: new Date('2026-10-11T12:00:00Z'),
    };
    const checklist = revisePendingRequestChecklistItem(initial, {
      task,
      ownerMessage,
      binding: {
        taskId: task.id,
        itemId: initial.items[0]?.id ?? '',
        expectedRevision: 0,
        ownerTaskId: task.id,
        ownerMessageId: ownerMessage.id,
      },
      evidence: { complete: true, rows: [] },
      replacement: { kind: 'lookup', label: 'Find my flight to Berlin' },
    });
    if (checklist === initial) throw new Error('correction fixture was rejected');
    const originalIntent: OwnerIntent = {
      sourceActor: 'owner',
      requestKind: 'new_request',
      ownerAuthoredText: initial.request,
      externalText: '',
      authorizedScopes: ['private_read', 'external_read'],
      separation: 'none',
    };
    const input = {
      task,
      checklist,
      ownerMessage,
      latestConversationOwnerMessageId: ownerMessage.id,
      originalIntent,
    };
    return { input, initial, checklist, ownerMessage };
  }

  it('keeps the corrected target and unchanged pending siblings under original scope', () => {
    const { input } = fixture();
    const blockedSibling = {
      ...input.checklist,
      items: input.checklist.items.map((item, index) =>
        index === 1 ? { ...item, status: 'blocked' as const } : item,
      ),
    };
    const projection = projectChecklistCorrectionResume({ ...input, checklist: blockedSibling });
    expect(projection).toMatchObject({
      originalRequest: 'Find my hotel and remind me about the hotel',
      authorizedScopes: ['private_read', 'external_read'],
      activeOutcomes: [
        { label: 'Find my flight to Berlin', kind: 'lookup', status: 'pending' },
        { label: 'remind me about the hotel', kind: 'reminder', status: 'blocked' },
      ],
    });
  });

  it('excludes completed and cancelled siblings while preserving stable IDs', () => {
    const { input, checklist } = fixture();
    const revised = {
      ...checklist,
      items: checklist.items.map((item, index) =>
        index === 1 ? { ...item, status: 'completed' as const } : item,
      ),
    };
    const projection = projectChecklistCorrectionResume({ ...input, checklist: revised });
    expect(projection?.activeOutcomes.map((item) => item.id)).toEqual([checklist.items[0]?.id]);
    expect(projection?.excludedOutcomeIds).toEqual([checklist.items[1]?.id]);
  });

  it('refuses a later unrelated conversation turn instead of rebinding the correction', () => {
    const { input } = fixture();
    expect(
      projectChecklistCorrectionResume({
        ...input,
        latestConversationOwnerMessageId: randomUUID(),
      }),
    ).toBeUndefined();
  });

  it('preserves unresolved clarification unchanged without adding its scopes', () => {
    const { input } = fixture();
    const clarificationContinuation = {
      sourceTaskId: randomUUID(),
      ownerAuthoredText: 'Find my hotel and remind me about the hotel',
      question: 'Which hotel?',
      authorizedScopes: ['private_read' as const],
      tainted: false,
      answerStatus: 'uncertain' as const,
    };
    expect(
      projectChecklistCorrectionResume({ ...input, clarificationContinuation }),
    ).toBeUndefined();
  });

  it('refuses changed text, foreign identity, broken revision binding, or an approval item', () => {
    const { input } = fixture();
    expect(
      projectChecklistCorrectionResume({
        ...input,
        ownerMessage: { ...input.ownerMessage, text: 'Find my hotel in Berlin' },
      }),
    ).toBeUndefined();
    expect(
      projectChecklistCorrectionResume({
        ...input,
        ownerMessage: { ...input.ownerMessage, taskId: randomUUID() },
      }),
    ).toBeUndefined();
    expect(
      projectChecklistCorrectionResume({
        ...input,
        checklist: { ...input.checklist, revisionAudit: [] },
      }),
    ).toBeUndefined();
    const awaitingApproval = {
      ...input.checklist,
      items: input.checklist.items.map((item, index) =>
        index === 1 ? { ...item, status: 'awaiting_approval' as const } : item,
      ),
    };
    expect(
      projectChecklistCorrectionResume({ ...input, checklist: awaitingApproval }),
    ).toBeUndefined();
  });
});
