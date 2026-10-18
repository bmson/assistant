import type { ModelRouter } from '@assistant/core/model-router';
import { describe, expect, it, vi } from 'vitest';
import { guardDraft } from './chat-guard.js';
import {
  replySentenceCount,
  replyWordCount,
  requestedReplySentenceLimit,
  requestedReplyWordLimit,
  reviewConversationReply,
  separateInlineReplyItems,
} from './conversation-reply-review.js';

const passingReasoningChecks = Object.fromEntries(
  ['grounding', 'feasibility', 'causalClaims', 'usefulness', 'actionScope'].map((name) => [
    name,
    { status: 'pass', explanation: 'The supplied facts support this answer.' },
  ]),
);

describe('reviewed conversation replies', () => {
  it.each([
    '**Handling steps:**\u202f1) Cancel the queued check.\u202f2) Verify whether the running worker stopped.',
    'Options: - **Local:** prepare a draft. - **Remote:** wait for the missing decision.',
    'Signals: • Check the supplied churn data. • Ask for evidence of demand.',
    '**Choice**: Compare the evidence. \u202f--- **Signals**: • Check the supplied churn data. • Ask for evidence of demand. \u202f--- **First step**: Prepare a reversible comparison.',
  ])('separates inline list items while preserving every non-whitespace character: %s', (draft) => {
    const formatted = separateInlineReplyItems(draft);
    expect(formatted).toContain('\n\n');
    expect(formatted.replace(/\s/g, '')).toBe(draft.replace(/\s/g, ''));
    expect(separateInlineReplyItems(formatted)).toBe(formatted);
  });

  it.each([
    'The measurements are 1.25 and 2.50.',
    'This is 1) an example referring to section 3) rather than an ordered list.',
    'Use `1) a 2) b` literally.',
    '```text\n1) Keep this literal. 2) Keep this too.\n```',
    '````text\n```\n1) This is literal code. 2) Still inside the longer fence.\n````',
    '    1) Indented code. 2) Still code.',
    '> 1) Quoted source. 2) Still quoted.',
    'The expression is alpha • beta • gamma.',
    'Use a • b • c to label the examples.',
    'One isolated bullet: • Keep this as supplied.',
    'Words --- **Label**: a single ambiguous dash separator.',
    'Use `• A. • B.` literally.',
    '> • Quoted first item. • Quoted second item.',
  ])('preserves code, decimals and ambiguous numbering: %s', (draft) => {
    expect(separateInlineReplyItems(draft)).toBe(draft);
  });

  it.each(['', ' in one paragraph', ' without line breaks'])(
    'formats collapsed scenario sections only when the owner permits it: %s',
    async (layout) => {
      const object = vi.fn().mockResolvedValue({
        ok: true,
        object: { decision: 'publish', reasons: [], checks: passingReasoningChecks },
      });
      const draft =
        '**Choice**: Compare the evidence. --- **Signals**: • Check supplied churn data. • Ask for demand evidence. --- **First step**: Prepare a reversible comparison.';
      const result = await reviewConversationReply({
        router: { object } as unknown as Pick<ModelRouter, 'object'>,
        taskId: 'task',
        request: `Use only this fictional scenario. Compare the choices${layout} under 80 words.`,
        draft,
        context: [],
        guard: (text) => ({ corrected: false, text }),
      });
      if (layout) expect(result.text).toBe(draft);
      else {
        expect(result.text).toContain('\n\n---\n\n**Signals**:');
        expect(result.text).toContain('\n\n• Check supplied churn data.\n\n• Ask');
      }
      expect(result.text.replace(/\s/g, '')).toBe(draft.replace(/\s/g, ''));
      expect(replyWordCount(result.text)).toBe(replyWordCount(draft));
      expect(result.incomplete).not.toBe(true);
      expect(object).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'in one paragraph',
    'as a single-line response',
    'in 1 paragraph',
    'as a single‑line response',
    'without line breaks',
    'in one short paragraph',
  ])(
    'preserves an explicit compact layout when a reasoning answer contains inline choices: %s',
    async (layout) => {
      const object = vi.fn().mockResolvedValue({
        ok: true,
        object: { decision: 'publish', reasons: [], checks: passingReasoningChecks },
      });
      const draft = '1) Prepare the draft for review. 2) Wait for the missing decision.';
      const result = await reviewConversationReply({
        router: { object } as unknown as Pick<ModelRouter, 'object'>,
        taskId: 'task',
        request: `Use only this fictional scenario. Compare the choices ${layout}.`,
        draft,
        context: [],
        guard: (text) => ({ corrected: false, text }),
      });
      expect(result.text).toBe(draft);
    },
  );
  it('repairs an explicit sentence limit without losing the supplied facts', async () => {
    const object = vi.fn().mockResolvedValue({
      ok: true,
      object: {
        decision: 'revise',
        revisedText: 'The project has a €240 budget, a Friday deadline, and no taxi travel.',
        reasons: ['clarity_or_format'],
      },
    });
    const result = await reviewConversationReply({
      router: { object } as unknown as Pick<ModelRouter, 'object'>,
      taskId: 'task',
      request: 'Acknowledge in one sentence: budget €240, deadline Friday, no taxi travel.',
      draft: 'The budget is €240. The deadline is Friday, with no taxi travel.',
      context: [],
      guard: (text) => ({ corrected: false, text }),
    });
    expect(result.text).toContain('€240');
    expect(result.text).toContain('Friday');
    expect(result.text).toContain('no taxi travel');
    expect(replySentenceCount(result.text)).toBe(1);
    expect(result.incomplete).not.toBe(true);
    expect(object.mock.calls[0]?.[1].prompt).toContain('limit is one sentence');
  });

  it('does not treat quoted or negative sentence instructions as an output limit', () => {
    expect(
      requestedReplySentenceLimit('Explain “reply in one sentence” in detail.'),
    ).toBeUndefined();
    expect(requestedReplySentenceLimit('Do not reply in one sentence.')).toBeUndefined();
    expect(requestedReplySentenceLimit('Do not use one sentence; write two.')).toBeUndefined();
    expect(requestedReplySentenceLimit('Do not reply in one short sentence.')).toBeUndefined();
    expect(requestedReplySentenceLimit('Give the result in one short sentence.')).toBe(1);
    expect(replySentenceCount('Dr. Green will arrive at 9 a.m. tomorrow.')).toBe(1);
    expect(
      replySentenceCount('The cost is €2.40, according to [the source](https://example.test/a.b).'),
    ).toBe(1);
  });

  it('uses the existing second pass to audit a successful short format repair', async () => {
    const object = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        object: {
          decision: 'revise',
          reasons: ['clarity_or_format'],
          revisedText: 'Compare the two supplied options, then review the choice tomorrow.',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        object: { decision: 'publish', reasons: [], checks: passingReasoningChecks },
      });
    const result = await reviewConversationReply({
      router: { object } as unknown as Pick<ModelRouter, 'object'>,
      taskId: 'task',
      request: 'Use only this fictional scenario. Compare two options under 20 words.',
      draft: Array(30).fill('draft').join(' '),
      context: [],
      guard: (text) => ({ corrected: false, text }),
    });
    expect(replyWordCount(result.text)).toBeLessThan(20);
    expect(object.mock.calls.map((call) => call[0])).toEqual(['rewrite', 'reason']);
    expect(result.incomplete).not.toBe(true);
  });

  it.each(['Do not use one sentence; write two.', 'Do not reply in one short sentence.'])(
    'keeps a valid two-sentence answer when the owner explicitly rejects that limit: %s',
    async (request) => {
      const object = vi
        .fn()
        .mockResolvedValue({ ok: true, object: { decision: 'publish', reasons: [] } });
      const draft = 'The first option is reversible. The second needs more evidence.';
      const result = await reviewConversationReply({
        router: { object } as unknown as Pick<ModelRouter, 'object'>,
        taskId: 'task',
        request,
        draft,
        context: [],
        guard: (text) => ({ corrected: false, text }),
      });
      expect(result.text).toBe(draft);
      expect(result.incomplete).not.toBe(true);
      expect(object).toHaveBeenCalledOnce();
    },
  );

  it('reserves the last pass for reasoning even when another format repair could fit', async () => {
    let formatCalls = 0;
    const object = vi.fn(async (role: string) =>
      role === 'reason'
        ? { ok: false, decision: { mode: 'park', reason: 'budget' } }
        : {
            ok: true,
            object: {
              decision: 'revise',
              reasons: ['clarity_or_format'],
              revisedText:
                ++formatCalls === 1
                  ? Array(25).fill('long').join(' ')
                  : 'Send to the invented recipient Morgan Green.',
            },
          },
    );
    const result = await reviewConversationReply({
      router: { object } as unknown as Pick<ModelRouter, 'object'>,
      taskId: 'task',
      request: 'Use only this fictional scenario. Compare the supplied options under 20 words.',
      draft: Array(30).fill('draft').join(' '),
      context: [],
      guard: (text) => ({ corrected: false, text }),
    });
    expect(object.mock.calls.map((call) => call[0])).toEqual(['rewrite', 'reason']);
    expect(formatCalls).toBe(1);
    expect(result.incomplete).toBe(true);
    expect(result.text).not.toContain('Morgan Green');
  });

  it('does not complete a format-revised scenario when its subsequent audit is unavailable', async () => {
    const object = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        object: {
          decision: 'revise',
          reasons: ['clarity_or_format'],
          revisedText: 'Compare the supplied options.',
        },
      })
      .mockResolvedValueOnce({ ok: false, decision: { mode: 'park', reason: 'budget' } });
    const result = await reviewConversationReply({
      router: { object } as unknown as Pick<ModelRouter, 'object'>,
      taskId: 'task',
      request: 'Use only this fictional scenario. Compare options under 20 words.',
      draft: Array(30).fill('draft').join(' '),
      context: [],
      guard: (text) => ({ corrected: false, text }),
    });
    expect(result.text).toBe('Compare the supplied options.');
    expect(result.incomplete).toBe(true);
    expect(object).toHaveBeenCalledTimes(2);
  });
  it('keeps audit exhaustion incomplete through the outer presentation and action guard', async () => {
    const object = vi.fn().mockResolvedValue({
      ok: true,
      object: {
        decision: 'publish',
        reasons: [],
        checks: {
          ...passingReasoningChecks,
          grounding: {
            status: 'revise',
            explanation: 'The contact address does not appear in the supplied facts.',
          },
        },
      },
    });
    const result = await reviewConversationReply({
      router: { object } as unknown as Pick<ModelRouter, 'object'>,
      taskId: 'task',
      request: 'Simulate only. Compare two possible recipients with the same first name. No tools.',
      draft: 'Choose Morgan Lee at morgan@example.test.',
      context: [],
      guard: (text) => guardDraft(text, []),
    });
    expect(object).toHaveBeenCalledTimes(2);
    expect(result.incomplete).toBe(true);
    expect(result.text).not.toContain('morgan@example.test');
  });
  it('distinguishes strict and inclusive limits and ignores quoted instructions', () => {
    expect(requestedReplyWordLimit('Compare the options under 220 words.')).toBe(219);
    expect(requestedReplyWordLimit('Use at most 170 words.')).toBe(170);
    expect(requestedReplyWordLimit('Explain “write under 12 words” in fewer than 90 words.')).toBe(
      89,
    );
    expect(replyWordCount('**Two** [source words](https://example.test/a/b)')).toBe(3);
  });

  it('rechecks a still-long revision without publishing an intermediate candidate', async () => {
    const final = 'Simulation only: compare both options and ask the owner to choose.';
    const object = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        object: {
          decision: 'revise',
          checks: passingReasoningChecks,
          revisedText: Array(24).fill('candidate').join(' '),
          reasons: ['clarity_or_format'],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        object: {
          decision: 'revise',
          checks: passingReasoningChecks,
          revisedText: final,
          reasons: ['clarity_or_format'],
        },
      });
    const result = await reviewConversationReply({
      router: { object } as unknown as Pick<ModelRouter, 'object'>,
      taskId: 'task',
      request: 'Use only this scenario. Compare options under 20 words.',
      draft: Array(30).fill('draft').join(' '),
      context: [],
      guard: (text) => ({ corrected: false, text }),
    });
    expect(result.text).toBe(final);
    expect(replyWordCount(result.text)).toBeLessThan(20);
    expect(object).toHaveBeenCalledTimes(2);
    expect(object.mock.calls[0]?.[1].prompt).toContain('30 display words');
    expect(object.mock.calls[1]?.[1].prompt).toContain('24 display words');
  });

  it.each([true, false])(
    'keeps a rejected receipt incomplete when review is available: %s',
    async (available) => {
      const object = vi.fn().mockResolvedValue(
        available
          ? {
              ok: true,
              object: { decision: 'publish', checks: passingReasoningChecks, reasons: [] },
            }
          : { ok: false, decision: { mode: 'park', reason: 'budget' } },
      );
      const result = await reviewConversationReply({
        router: { object } as unknown as Pick<ModelRouter, 'object'>,
        taskId: 'task',
        request: 'Simulate only a fictional reply. No tools.',
        draft: 'I sent the email to Bob.',
        context: [],
        guard: (text) =>
          guardDraft(text, [], { requestText: 'Simulate only a fictional reply. No tools.' }),
      });
      expect(object).toHaveBeenCalledTimes(available ? 2 : 1);
      expect(result.corrected).toBe(true);
      expect(result.incomplete).toBe(true);
      expect(result.text).not.toBe('I sent the email to Bob.');
    },
  );

  it('keeps a valid answer if optional review is unavailable', async () => {
    const object = vi
      .fn()
      .mockResolvedValue({ ok: false, decision: { mode: 'park', reason: 'budget' } });
    const draft = 'Simulation only: first compare the options, then ask for the missing decision.';
    const result = await reviewConversationReply({
      router: { object } as unknown as Pick<ModelRouter, 'object'>,
      taskId: 'task',
      request: 'Simulate only a fictional decision. No tools.',
      draft,
      context: [],
      guard: (text) => guardDraft(text, []),
    });
    expect(result).toEqual({ corrected: false, text: draft });
    expect(object).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'withholds a known word overrun when review cannot repair it (available: %s)',
    async (available) => {
      const object = vi.fn().mockResolvedValue(
        available
          ? {
              ok: true,
              object: { decision: 'publish', checks: passingReasoningChecks, reasons: [] },
            }
          : { ok: false, decision: { mode: 'park', reason: 'budget' } },
      );
      const result = await reviewConversationReply({
        router: { object } as unknown as Pick<ModelRouter, 'object'>,
        taskId: 'task',
        request: 'Use only this scenario. Compare options under 20 words.',
        draft: Array(30).fill('draft').join(' '),
        context: [],
        guard: (text) => ({ corrected: false, text }),
      });
      expect(result.incomplete).toBe(true);
      expect(replyWordCount(result.text)).toBeLessThan(20);
      expect(result.text).not.toContain('draft draft');
      expect(object).toHaveBeenCalledTimes(available ? 2 : 1);
    },
  );
});
