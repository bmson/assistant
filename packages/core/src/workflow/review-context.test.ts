import { describe, expect, it } from 'vitest';
import { buildReviewContext } from './review-context.js';

describe('bounded review context', () => {
  it('keeps owner corrections when assistant turns would evict them', () => {
    const result = buildReviewContext('Revise the plan using my correction.', [
      { role: 'user', content: 'Twelve people; $1200 total budget.' },
      { role: 'user', content: 'Correction: six people; keep the budget; access comes first.' },
      ...Array.from({ length: 8 }, () => ({
        role: 'assistant',
        content: 'The venue is available. A worksheet and travel radius exist.',
      })),
      { role: 'tool', content: 'TOOL_SECRET' },
      { role: 'system', content: 'SYSTEM_SECRET' },
    ]);
    const context = JSON.parse(result.contextJson);
    expect(context.ownerTurns.map((turn: { text: string }) => turn.text)).toEqual([
      'Twelve people; $1200 total budget.',
      'Correction: six people; keep the budget; access comes first.',
    ]);
    expect(context.omittedAssistantTurns).toBe(6);
    expect(context.assistantTurns.map((turn: { turnIndex: number }) => turn.turnIndex)).toEqual([
      8, 9,
    ]);
    expect(result.ownerFacts).toContain('Correction: six people');
    expect(result.ownerFacts).not.toMatch(/worksheet|available/);
    expect(result.contextJson).not.toMatch(/TOOL_SECRET|SYSTEM_SECRET/);
  });

  it.each(['people', 'budget', 'deadline', 'recipient'])(
    'retains a trailing %s correction and marks omissions explicitly',
    (subject) => {
      const correction = `Correction to ${subject}: use the new value only.`;
      const result = buildReviewContext(
        `Use only this scenario. ${'setup '.repeat(1000)}${correction}`,
        [{ role: 'user', content: `Earlier setup. ${'detail '.repeat(1000)}${correction}` }],
      );
      expect(result.request).toContain(correction);
      expect(result.request.length).toBeLessThanOrEqual(4000);
      expect(result.ownerFacts).toContain(correction);
      const context = JSON.parse(result.contextJson);
      expect(context.ownerTurns[0].text).toContain(correction);
      expect(context.ownerTurns[0].truncated).toBe(true);
    },
  );

  it('retains the offer preceding an owner selection across different role interleavings', () => {
    const firstOffer = { role: 'assistant', content: 'Choose plan A or plan B.' };
    const secondOffer = { role: 'assistant', content: 'Alternatively, choose plan C or plan D.' };
    const selection = { role: 'user', content: 'Use the first option.' };
    const before = buildReviewContext('Explain my selected plan.', [
      firstOffer,
      selection,
      secondOffer,
    ]);
    const after = buildReviewContext('Explain my selected plan.', [
      firstOffer,
      secondOffer,
      selection,
    ]);
    const precedingOffer = (serialized: string) => {
      const context = JSON.parse(serialized);
      return context.assistantTurns
        .filter((turn: { turnIndex: number }) => turn.turnIndex < context.ownerTurns[0].turnIndex)
        .at(-1).text;
    };
    expect(before.contextJson).not.toBe(after.contextJson);
    expect(precedingOffer(before.contextJson)).toBe(firstOffer.content);
    expect(precedingOffer(after.contextJson)).toBe(secondOffer.content);
    expect(before.ownerFacts).toBe(after.ownerFacts);
    expect(before.ownerFacts).not.toMatch(/plan [ABCD]/);
  });

  it('caps escaped JSON while preserving the latest owner turn and exact source-check corpus', () => {
    const result = buildReviewContext('Current request.', [
      ...Array.from({ length: 10 }, (_, index) => ({
        role: 'user',
        content: `Old ${index}. ${'\u0001'.repeat(3000)}`,
      })),
      { role: 'user', content: 'Latest correction: $800 total, eight people, draft only.' },
    ]);
    expect(result.contextJson.length).toBeLessThanOrEqual(4000);
    const context = JSON.parse(result.contextJson);
    expect(context.ownerTurns.at(-1).text).toContain('Latest correction: $800 total');
    expect(context.ownerTurns.at(-1).turnIndex).toBe(10);
    expect(context.omittedOwnerTurns).toBeGreaterThan(0);
    expect(result.ownerFacts).toBe(
      [...context.ownerTurns.map((turn: { text: string }) => turn.text), result.request].join('\n'),
    );
  });
});
