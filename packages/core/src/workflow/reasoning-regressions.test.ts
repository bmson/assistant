import { describe, expect, it, vi } from 'vitest';
import { CONVERSATION_REASONING_DIRECTIVE } from './conversation-local-context.js';
import frozen from './fixtures/reasoning-d66.json' with { type: 'json' };
import { REASONING_VERIFICATION_SYSTEM, verifyFinalOutput } from './output-verification.js';
import { REASONING_CRITERIA } from './reasoning-criteria.js';

const checks = (key?: string, explanation?: string) =>
  Object.fromEntries(
    Object.keys(REASONING_CRITERIA).map((name) => [
      name,
      {
        status: name === key ? 'revise' : 'pass',
        explanation:
          name === key ? explanation : 'The returned candidate stays within the supplied scenario.',
      },
    ]),
  );

describe('scenario candidate review regressions (scripted, no model quality grades)', () => {
  it('shares the same criteria between generation and review', () => {
    for (const criterion of Object.values(REASONING_CRITERIA)) {
      expect(CONVERSATION_REASONING_DIRECTIVE).toContain(criterion);
      expect(REASONING_VERIFICATION_SYSTEM).toContain(criterion);
    }
  });

  it('publishes a complete terse decision without spending a correction call', async () => {
    const object = vi.fn(async () => ({
      ok: true,
      object: { decision: 'publish', reasons: [], checks: checks() },
    }));
    const result = await verifyFinalOutput({ object } as never, {
      taskId: 'terse-decision',
      request: 'Simulate only: A fits the budget; B exceeds it. Reply only "Choose A.".',
      draft: 'Choose A.',
      evidence: [],
      critical: true,
      reasoningReview: true,
    });
    expect(object).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Choose A.');
    expect(result.incomplete).toBeUndefined();
  });

  it('rejects a structurally unfinished audited completion repair within two calls', async () => {
    let calls = 0;
    const object = vi.fn(async () => ({
      ok: true,
      object: {
        decision: 'revise',
        revisedText:
          ++calls === 1
            ? 'Only A is supported; the remaining requested details are not established.'
            : '```text\nOnly A is supported; the remaining details are not established.',
        reasons: ['ungrounded_fact'],
        checks: checks(),
      },
    }));
    const result = await verifyFinalOutput({ object } as never, {
      taskId: 'structural-repair',
      request: 'Use only the supplied evidence to identify the supported result.',
      draft: `UNSUPPORTED_DETAILS ${'The original asserted unverified material. '.repeat(30)}`,
      evidence: [],
      critical: true,
      reasoningReview: true,
    });
    expect(object).toHaveBeenCalledTimes(2);
    expect(result.incomplete).toBe(true);
    expect(result.text).not.toMatch(/UNSUPPORTED_DETAILS|```/);
  });

  it.each(
    frozen.cases.flatMap((item) =>
      ['publish', 'revise'].map((firstDecision) => ({ ...item, firstDecision })),
    ),
  )(
    'withholds unresolved frozen failure $id after $firstDecision and changed revisions',
    async (item) => {
      let calls = 0;
      const object = vi.fn(async () => ({
        ok: true,
        object: {
          decision: ++calls === 1 ? item.firstDecision : 'revise',
          // A changed answer must not launder an explicitly unresolved defect.
          revisedText: `${item.draft}\n\nConsider the options carefully (${calls}).`,
          reasons: ['ungrounded_fact'],
          checks: checks(item.check, item.finding),
        },
      }));
      const result = await verifyFinalOutput({ object } as never, {
        taskId: item.id,
        request: item.request,
        draft: item.draft,
        evidence: [],
        critical: true,
        reasoningReview: true,
      });
      expect(object).toHaveBeenCalledTimes(2);
      expect(result.incomplete).toBe(true);
      expect(result.text).toBe(
        'I couldn’t produce a complete answer that I can support from the available evidence.',
      );
    },
  );

  it.each([
    [
      'rate',
      'causalClaims',
      'Simulate only. Starts fell from 800 to 400 and completions from 600 to 360. Assess abandonment.',
      'Starts/completions is abandonment.',
      'Abandonment is 25% before and 10% after, using noncompleting starts/all starts; this alone does not establish the cause.',
    ],
    [
      'budget',
      'feasibility',
      'Use only this scenario: $875 room quote, $700 total budget. Assess feasibility.',
      'Cut catering by $175 and the room fits.',
      'The room alone exceeds the total by at least $175 before extras. A lower quote, another plan, or an explicitly larger budget is needed.',
    ],
    [
      'deadline',
      'feasibility',
      'Fictional plan only: approval due Tuesday; the approver returns Wednesday. Revise the plan.',
      'Move approval to Wednesday; every deadline is met.',
      'The Tuesday approval deadline cannot be met on those facts. Propose renegotiation and prepare a draft meanwhile; approval remains pending.',
    ],
    [
      'recipient',
      'grounding',
      'Simulate only. Two contacts share the name Sam; draft only, no selected address. Ask the smallest decision.',
      'Choose Sam Jones or Sam Lee.',
      'Which exact Sam/contact address should the draft use? Wording and subject preparation can continue; sending still needs separate authority.',
    ],
  ])(
    'uses one correction for a varied %s case and accepts a fully audited replacement',
    async (_id, key, request, draft, repaired) => {
      let calls = 0;
      const object = vi.fn(async () => ({
        ok: true,
        object:
          ++calls === 1
            ? {
                decision: 'publish',
                reasons: [],
                checks: checks(
                  key,
                  'The candidate contradicts a supplied constraint and requires correction.',
                ),
              }
            : {
                decision: 'revise',
                revisedText: repaired,
                reasons: ['ungrounded_fact'],
                checks: checks(),
              },
      }));
      const result = await verifyFinalOutput({ object } as never, {
        taskId: 'varied',
        request,
        draft,
        evidence: [],
        critical: true,
        reasoningReview: true,
      });
      expect(object).toHaveBeenCalledTimes(2);
      expect(result.text).toBe(repaired);
      expect(result.incomplete).toBeUndefined();
    },
  );

  it.each(['missing audit', 'missing replacement', 'collapsed replacement'])(
    'cannot bypass a candidate audit with a %s',
    async (kind) => {
      const draft = `## Plan\n${'Compare both options and keep the unknown constraints explicit. '.repeat(12)}`;
      const object = vi.fn(async () => ({
        ok: true,
        object: {
          decision: 'revise',
          ...(kind !== 'missing replacement'
            ? {
                revisedText:
                  kind === 'collapsed replacement'
                    ? 'Consider both.'
                    : `${draft}\nReview the result.`,
              }
            : {}),
          reasons: ['ungrounded_fact'],
          ...(kind !== 'missing audit' ? { checks: checks() } : {}),
        },
      }));
      const result = await verifyFinalOutput({ object } as never, {
        taskId: kind,
        request: 'Use only this scenario. Compare two options.',
        draft,
        evidence: [],
        critical: true,
        reasoningReview: true,
      });
      expect(object).toHaveBeenCalledTimes(2);
      expect(result.incomplete).toBe(true);
      expect(result.text).not.toBe(draft);
    },
  );

  it.each(['budget', 'throw'])(
    'does not restore a known bad candidate when its correction fails: %s',
    async (failure) => {
      let calls = 0;
      const object = vi.fn(async () => {
        if (++calls === 1)
          return {
            ok: true,
            object: {
              decision: 'revise',
              revisedText: 'Reallocate the other costs; the room fits.',
              reasons: ['ungrounded_fact'],
              checks: checks(
                'feasibility',
                'The room alone costs more than the entire supplied budget.',
              ),
            },
          };
        if (failure === 'throw') throw new Error('offline provider');
        return { ok: false, decision: { mode: 'park', reason: 'budget' } };
      });
      const result = await verifyFinalOutput({ object } as never, {
        taskId: failure,
        request: 'Use only this scenario: room $875, total budget $700.',
        draft: 'The room is affordable.',
        evidence: [],
        critical: true,
        reasoningReview: true,
      });
      expect(object).toHaveBeenCalledTimes(2);
      expect(result.incomplete).toBe(true);
      expect(result.unavailable).toBe(true);
      expect(result.text).not.toMatch(/affordable|Reallocate/);
    },
  );
});
