import type { ModelRouter } from '@assistant/core/model-router';
import { describe, expect, it, vi } from 'vitest';
import { guardDraft } from './chat-guard.js';
import {
  replyWordCount,
  requestedReplyWordLimit,
  reviewConversationReply,
} from './conversation-reply-review.js';

describe('reviewed conversation replies', () => {
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
          revisedText: Array(24).fill('candidate').join(' '),
          reasons: ['clarity_or_format'],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        object: { decision: 'revise', revisedText: final, reasons: ['clarity_or_format'] },
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

  it('keeps the real action contract authoritative when a reviewer approves a false receipt', async () => {
    const object = vi
      .fn()
      .mockResolvedValue({ ok: true, object: { decision: 'publish', reasons: [] } });
    const result = await reviewConversationReply({
      router: { object } as unknown as Pick<ModelRouter, 'object'>,
      taskId: 'task',
      request: 'Simulate only a fictional reply. No tools.',
      draft: 'I sent the email to Bob.',
      context: [],
      guard: (text) =>
        guardDraft(text, [], { requestText: 'Simulate only a fictional reply. No tools.' }),
    });
    expect(object).toHaveBeenCalledTimes(2);
    expect(result.corrected).toBe(true);
    expect(result.text).not.toBe('I sent the email to Bob.');
  });

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
});
