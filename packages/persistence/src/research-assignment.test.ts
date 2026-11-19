import { describe, expect, it } from 'vitest';
import {
  acceptResearchShortlist,
  assertResearchAssignmentBriefPatch,
  assertResearchAssignmentCreateInput,
  assertResearchAssignmentOptionsInput,
  assertResearchAssignmentState,
  createResearchAssignment,
  editResearchAssignmentBrief,
  recordResearchAssignmentOptions,
  reopenResearchAssignment,
  setResearchAssignmentStoppedState,
} from './research-assignment.js';
import { goalAutomationEligible } from './schedules.js';

const now = new Date('2026-11-06T18:00:00.000Z');

function assignment() {
  return createResearchAssignment({
    assignmentId: 'assignment-1',
    outcome: 'Research three gardening gifts',
    recipientName: 'Synthetic recipient',
    interests: ['gardening'],
    completionCondition: 'Owner accepts the shortlist',
    budget: {
      state: 'known',
      amount: '100.00',
      currency: 'USD',
      includesTaxAndDelivery: true,
    },
    deadline: {
      state: 'known',
      at: '2026-12-05T17:00:00-08:00',
      timeZone: 'America/Los_Angeles',
    },
    now,
  });
}

describe('research-only assignment state', () => {
  it('treats absent legacy state like SQL null but fails closed on any present value', () => {
    expect(goalAutomationEligible({})).toBe(true);
    expect(goalAutomationEligible({ researchAssignment: null })).toBe(true);
    expect(goalAutomationEligible({ researchAssignment: assignment() })).toBe(false);
    expect(goalAutomationEligible({ researchAssignment: { malformed: true } as never })).toBe(
      false,
    );
  });

  it('creates a draft with unknowns explicit and no work or schedule binding', () => {
    const value = createResearchAssignment({
      assignmentId: 'assignment-1',
      outcome: 'Find a birthday gift',
      completionCondition: 'Owner accepts a shortlist',
      now,
    });
    expect(value.status).toBe('draft');
    expect(value.budget.state).toBe('unknown');
    expect(value.deadline.state).toBe('unknown');
    expect(value.scope).toEqual({
      kind: 'research_only',
      contactAllowed: false,
      purchaseAllowed: false,
    });
    expect(value.taskId).toBeNull();
    expect(value.conversationId).toBeNull();
  });

  it('requires total budget and explicit deadline timezone', () => {
    expect(() =>
      createResearchAssignment({
        assignmentId: 'assignment-1',
        outcome: 'Gift',
        completionCondition: 'Accept shortlist',
        budget: { state: 'known', amount: '100', currency: 'USD', includesTaxAndDelivery: false },
        now,
      }),
    ).toThrow('include tax and delivery');
    expect(() =>
      createResearchAssignment({
        assignmentId: 'assignment-1',
        outcome: 'Gift',
        completionCondition: 'Accept shortlist',
        deadline: { state: 'known', at: '2026-12-05T17:00:00Z', timeZone: null },
        now,
      }),
    ).toThrow('explicit IANA time zone');
  });

  it('does not allow a brief edit to expand research-only authority', () => {
    expect(() =>
      editResearchAssignmentBrief(
        assignment(),
        { scope: { kind: 'research_only', contactAllowed: true, purchaseAllowed: false } } as never,
        now,
      ),
    ).toThrow('unsupported field');
  });

  it('rejects malformed nested edits and persisted envelopes at runtime', () => {
    expect(() =>
      assertResearchAssignmentCreateInput({
        outcome: 'Gift',
        completionCondition: 'Accept shortlist',
        recipientName: 5,
      }),
    ).toThrow('Recipient name must be text or unknown');
    expect(() =>
      assertResearchAssignmentCreateInput({
        outcome: 'Gift',
        completionCondition: 'Accept shortlist',
        startTask: true,
      }),
    ).toThrow('Assignment outcome and completion condition are required');
    expect(() => assertResearchAssignmentBriefPatch({ recipient: null })).toThrow(
      'Recipient details are malformed',
    );
    expect(() =>
      assertResearchAssignmentBriefPatch({
        budget: { state: 'unknown', amount: null, currency: null },
      }),
    ).toThrow('Budget details are malformed');
    expect(() =>
      assertResearchAssignmentBriefPatch({
        deadline: { state: 'known', at: '2026-12-05T17:00:00Z', timeZone: null },
      }),
    ).toThrow('Known deadline requires an explicit IANA time zone');
    expect(() => assertResearchAssignmentBriefPatch({ interests: ['gardening', 3] })).toThrow(
      'Interests must be a list of strings',
    );
    expect(() =>
      assertResearchAssignmentBriefPatch({
        recipient: { name: 'Synthetic recipient', contactId: null, extra: 1 },
      }),
    ).toThrow('Recipient details are malformed');
    expect(() => assertResearchAssignmentState({ ...assignment(), recipient: null })).toThrow(
      'Research assignment record is malformed or unsupported',
    );
    expect(() => assertResearchAssignmentState({ ...assignment(), extra: 'unexpected' })).toThrow(
      'Research assignment record is malformed or unsupported',
    );
  });

  it('rejects malformed JSON action payloads before repository admission', () => {
    const malformed = JSON.parse(
      JSON.stringify({
        expectedBriefRevision: 1,
        expectedResultRevision: null,
        options: [
          {
            id: 'synthetic-option',
            title: 'Synthetic option',
            description: '',
            sourceName: 'Synthetic catalog',
            itemCost: null,
            taxCost: null,
            deliveryCost: null,
            currency: null,
            availability: 'available-ish',
            deliveryConfidence: 'unknown',
            purchase: true,
          },
        ],
      }),
    );
    expect(() => assertResearchAssignmentOptionsInput(malformed)).toThrow(
      'Research option details are malformed',
    );
  });

  it('calculates total budget from item, tax, and delivery while leaving missing evidence unknown', () => {
    const result = recordResearchAssignmentOptions(
      assignment(),
      {
        expectedBriefRevision: 1,
        expectedResultRevision: null,
        recommendationId: 'complete',
        options: [
          {
            id: 'complete',
            title: 'Garden gloves',
            description: '',
            sourceName: 'Synthetic shop',
            sourceUrl: 'https://example.invalid/gloves',
            itemCost: '80.00',
            taxCost: '8.00',
            deliveryCost: '12.00',
            currency: 'USD',
            availability: 'verified_available',
            deliveryConfidence: 'verified',
          },
          {
            id: 'unknown-delivery',
            title: 'Seed kit',
            description: '',
            sourceName: 'Synthetic shop',
            itemCost: '40',
            taxCost: '4',
            deliveryCost: null,
            currency: 'USD',
            availability: 'stale',
            deliveryConfidence: 'unknown',
          },
        ],
      },
      now,
    );
    expect(result.status).toBe('waiting_for_decision');
    expect(result.evidence.options[0]?.totalCost).toBe('100.00');
    expect(result.evidence.options[0]?.budgetAssessment).toBe('within_limit');
    expect(result.evidence.options[1]?.totalCost).toBeNull();
    expect(result.evidence.options[1]?.budgetAssessment).toBe('unknown');
    expect(result.evidence.options[1]?.availability).toBe('stale');
    expect(result.evidence.unverifiedCount).toBe(1);
    expect(() =>
      recordResearchAssignmentOptions(
        result,
        {
          expectedBriefRevision: 1,
          expectedResultRevision: null,
          options: [
            {
              id: 'retry',
              title: 'Retry result',
              description: '',
              sourceName: 'Synthetic shop',
              itemCost: null,
              taxCost: null,
              deliveryCost: null,
              currency: null,
              availability: 'unknown',
              deliveryConfidence: 'unknown',
            },
          ],
        },
        now,
      ),
    ).toThrow('Research result changed while this update was in progress');
    const edited = editResearchAssignmentBrief(result, { exclusions: ['plastic'] }, now);
    expect(() =>
      recordResearchAssignmentOptions(
        edited,
        {
          expectedBriefRevision: 1,
          expectedResultRevision: result.evidence.resultRevision,
          options: [
            {
              id: 'late',
              title: 'Late result',
              description: '',
              sourceName: 'Synthetic shop',
              itemCost: null,
              taxCost: null,
              deliveryCost: null,
              currency: null,
              availability: 'unknown',
              deliveryConfidence: 'unknown',
            },
          ],
        },
        now,
      ),
    ).toThrow('Assignment brief changed while research was in progress');
  });

  it('stales old evidence on material edits and preserves it on reopen', () => {
    const current = {
      ...assignment(),
      status: 'waiting_for_decision' as const,
      resultBriefRevision: 1,
      currentness: 'checked_at' as const,
      evidence: {
        resultRevision: 7,
        checkedAt: '2026-11-06T17:00:00.000Z',
        optionCount: 3,
        unverifiedCount: 1,
        recommendationId: null,
        options: [],
      },
    };
    const edited = editResearchAssignmentBrief(current, { exclusions: ['plastic'] }, now);
    expect(edited.briefRevision).toBe(2);
    expect(edited.status).toBe('needs_recheck');
    expect(edited.currentness).toBe('stale');
    expect(edited.evidence).toEqual(current.evidence);

    const reopened = reopenResearchAssignment(current, now);
    expect(reopened.status).toBe('needs_recheck');
    expect(reopened.taskId).toBeNull();
    expect(reopened.evidence).toEqual(current.evidence);
  });

  it('keeps brief revisions separate from monotonic result revisions', () => {
    const options = (id: string) => [
      {
        id,
        title: 'Synthetic option',
        description: '',
        sourceName: 'Synthetic catalog',
        itemCost: null,
        taxCost: null,
        deliveryCost: null,
        currency: null,
        availability: 'unknown' as const,
        deliveryConfidence: 'unknown' as const,
      },
    ];
    const first = recordResearchAssignmentOptions(
      assignment(),
      { expectedBriefRevision: 1, expectedResultRevision: null, options: options('one') },
      now,
    );
    const second = recordResearchAssignmentOptions(
      first,
      { expectedBriefRevision: 1, expectedResultRevision: 1, options: options('two') },
      now,
    );
    expect(second.briefRevision).toBe(1);
    expect(second.resultBriefRevision).toBe(1);
    expect(second.evidence.resultRevision).toBe(2);
    expect(() => assertResearchAssignmentState(second)).not.toThrow();
    expect(acceptResearchShortlist(second, 2, now).status).toBe('completed');

    const editedTwice = editResearchAssignmentBrief(
      editResearchAssignmentBrief(assignment(), { outcome: 'Updated once' }, now),
      { exclusions: ['plastic'] },
      now,
    );
    const firstResultForLatestBrief = recordResearchAssignmentOptions(
      editedTwice,
      {
        expectedBriefRevision: 3,
        expectedResultRevision: null,
        options: options('first-current'),
      },
      now,
    );
    expect(firstResultForLatestBrief.briefRevision).toBe(3);
    expect(firstResultForLatestBrief.resultBriefRevision).toBe(3);
    expect(firstResultForLatestBrief.evidence.resultRevision).toBe(1);
    expect(() => assertResearchAssignmentState(firstResultForLatestBrief)).not.toThrow();
    expect(() =>
      assertResearchAssignmentState({ ...firstResultForLatestBrief, resultBriefRevision: null }),
    ).toThrow('Research assignment evidence revisions are inconsistent');
    const completed = acceptResearchShortlist(
      firstResultForLatestBrief,
      firstResultForLatestBrief.evidence.resultRevision as number,
      now,
    );
    expect(() =>
      assertResearchAssignmentState({ ...completed, resultBriefRevision: null }),
    ).toThrow('Research assignment evidence revisions are inconsistent');
  });

  it('completes only on explicit acceptance of the current shortlist revision', () => {
    const current = {
      ...assignment(),
      status: 'waiting_for_decision' as const,
      resultBriefRevision: 1,
      evidence: {
        resultRevision: 8,
        checkedAt: '2026-11-06T17:00:00.000Z',
        optionCount: 3,
        unverifiedCount: 1,
        recommendationId: null,
        options: [],
      },
    };
    expect(() => acceptResearchShortlist(current, 7, now)).toThrow(
      'Shortlist revision does not match the current evidence',
    );
    const completed = acceptResearchShortlist(current, 8, now);
    expect(completed.status).toBe('completed');
    expect(completed.completion).toEqual({
      resultRevision: 8,
      acceptedAt: now.toISOString(),
    });
  });

  it('pauses or cancels future work without claiming a dispatched task stopped', () => {
    const active = {
      ...assignment(),
      status: 'researching' as const,
      taskId: 'task-1',
      conversationId: 'conversation-1',
    };
    const paused = setResearchAssignmentStoppedState(active, 'paused', now);
    expect(paused.status).toBe('paused');
    expect(paused.taskId).toBe('task-1');
    expect(paused.stateReason).toContain('may still be running');
    const cancelled = setResearchAssignmentStoppedState(active, 'cancelled', now);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.taskId).toBe('task-1');
    expect(() => reopenResearchAssignment(cancelled, now)).toThrow('cannot be reopened');
  });
});
