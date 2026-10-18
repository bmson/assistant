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
    expect(context.omittedOwnerTurns).toBeGreaterThan(0);
    expect(result.ownerFacts).toBe(
      [...context.ownerTurns.map((turn: { text: string }) => turn.text), result.request].join('\n'),
    );
  });
});
