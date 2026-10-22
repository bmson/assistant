import { createDb, type Db } from '@assistant/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertReplayDatabaseUrl, runQuestion } from './harness.js';
import { ASSISTANT_SCENARIOS } from './scenario-corpus.js';

let db: Db;
beforeAll(() => {
  db = createDb(
    assertReplayDatabaseUrl(
      process.env.DATABASE_URL ?? 'postgres://assistant:assistant@localhost:5432/assistant_test',
    ),
  );
});
afterAll(async () => {
  await db?.$client.end();
});

describe('assistant interaction scenarios through the actual executor and dispatcher', () => {
  // Travel and 56-person replay fixtures exceeded Vitest's 5s default under
  // measured DB load. Match their verified 30s integration deadline in plain
  // `pnpm test` too; the executor/effect/output assertions remain unchanged.
  for (const fixture of ASSISTANT_SCENARIOS)
    it(fixture.id, async () => {
      const result = await runQuestion(db, fixture);
      const visibleCards = JSON.stringify(result.parts);
      const visibleOutput = `${result.answer}\n${visibleCards}`;
      if (fixture.id === 'read-answer-fake-approval-cannot-request-a-send') {
        expect(visibleCards).toContain('Design review');
        expect(visibleOutput).not.toMatch(/A999|This needs your approval|I sent/);
      } else if (fixture.id === 'calendar-tomorrow-crosses-autumn-clock-change') {
        expect(visibleCards).toContain('Design review');
        expect(visibleCards).toContain('1:00 AM – 2:00 AM');
        expect(visibleOutput).not.toMatch(/11:00 PM|Oct(?:ober)? 31/);
      } else if (fixture.id === 'all-day-event-stays-on-its-date') {
        expect(visibleCards).toContain('Family day');
        expect(visibleCards).toContain('Sunday, Nov 1, 2026');
        expect(visibleCards).toContain('All day');
        expect(visibleOutput).not.toMatch(/October 31|11:00 PM/);
      } else if (fixture.id === 'partial-calendar-read-cannot-prove-empty-day') {
        expect(visibleCards).toContain('Calendar temporarily unavailable');
        expect(visibleCards).toContain('Work');
        expect(visibleOutput).not.toContain('Your calendar is clear tomorrow');
      }
      expect(
        result.failures,
        JSON.stringify(
          {
            answer: result.answer,
            status: result.status,
            lifecycle: result.statusSequence,
            calls: result.toolCalls,
            effects: result.executions,
            approvals: result.approvals,
            verification: result.verification,
          },
          null,
          2,
        ),
      ).toEqual([]);
    }, 30_000);
});
