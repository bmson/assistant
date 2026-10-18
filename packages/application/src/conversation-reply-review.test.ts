import type { ModelRouter } from '@assistant/core/model-router';
import { describe, expect, it, vi } from 'vitest';
import { guardDraft } from './chat-guard.js';
import {
  replyWordCount,
  requestedReplyWordLimit,
  reviewConversationReply,
} from './conversation-reply-review.js';

const passingReasoningChecks = Object.fromEntries(
  ['grounding', 'feasibility', 'causalClaims', 'usefulness', 'actionScope'].map((name) => [
    name,
    { status: 'pass', explanation: 'The supplied facts support this answer.' },
  ]),
);

describe('reviewed conversation replies', () => {
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
