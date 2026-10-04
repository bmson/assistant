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
  for (const fixture of ASSISTANT_SCENARIOS)
    it(fixture.id, async () => {
      const result = await runQuestion(db, fixture);
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
    });
});
