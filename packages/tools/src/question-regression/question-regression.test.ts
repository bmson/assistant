import { createDb, type Db } from '@assistant/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APPLICATION_CASES, QUESTION_CASES } from './corpus.js';
import {
  assertReplayDatabaseUrl,
  evaluateQuestion,
  type QuestionResult,
  runQuestion,
  summarizeQuestions,
} from './harness.js';

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

describe('audited owner questions through executor and dispatcher', () => {
  for (const fixture of QUESTION_CASES)
    it(fixture.id, async () => {
      const result = await runQuestion(db, fixture);
      if (fixture.id === 'calendar-and-failed-weather') {
        const visibleCards = JSON.stringify(result.parts);
        expect(visibleCards).toContain('Design review');
        expect(`${result.answer}\n${visibleCards}`).not.toMatch(/22°C|sunny/);
      }
      expect(
        result.failures,
        JSON.stringify(
          {
            answer: result.answer,
            status: result.status,
            tools: result.toolCalls,
            saved: result.saved.length,
          },
          null,
          2,
        ),
      ).toEqual([]);
    });
});

it('accounts for every owner turn in the home snapshot and follow-up', () => {
  const records = new Set(
    [...QUESTION_CASES, ...APPLICATION_CASES].flatMap((item) => item.records),
  );
  expect([...records].sort((a, b) => a - b)).toEqual([
    653, 658, 664, 666, 668, 670, 672, 674, 678, 683, 685, 688, 690, 693, 695, 697, 699, 701, 703,
    705, 707, 709, 712, 717, 720, 727, 736, 738, 740, 742, 744, 746, 748, 750,
  ]);
});

it('refuses production, remote, ambiguous and overridden database targets', () => {
  for (const url of [
    'postgres://u:p@localhost/assistant',
    'postgres://u:p@db.example.org/assistant_test',
    'postgres://u:p@localhost/assistant_test?host=db.example.org',
    'postgres://u:p@localhost/assistant_test#override',
    'https://localhost/assistant_test',
  ])
    expect(() => assertReplayDatabaseUrl(url)).toThrow();
});

it('fails a wrong score even when the lookup succeeded and the task says done', () => {
  const fixture = QUESTION_CASES.find((item) => item.id === 'giants-score');
  if (!fixture) throw new Error('missing fixture');
  const result: QuestionResult = {
    id: fixture.id,
    records: fixture.records,
    mode: 'scripted',
    status: 'done',
    answer: 'Final: Giants 7–3.',
    parts: [],
    toolCalls: ['web.search', 'web.fetch'].map((name) => ({
      name,
      status: 'succeeded',
      args: {},
      result: {},
    })),
    approvals: 0,
    saved: [],
    elapsedMs: 10,
    costUsd: 0,
    modelCalls: [],
    verification: [],
    failures: [],
  };
  expect(evaluateQuestion(fixture, result)).toContain(
    'answer: forbidden (?:Giants|score|ahead|lead).{0,20}7\\s*[–−-]\\s*3',
  );
  expect(
    evaluateQuestion(fixture, {
      ...result,
      answer: 'Final: Giants 5, Cardinals 4 in 11 innings.',
      status: 'waiting_approval',
    }),
  ).toContain('completion: waiting_approval, expected done');
  expect(summarizeQuestions([{ ...result, failures: ['wrong answer'] }])).toMatchObject({
    cases: 1,
    passed: 0,
    failed: 1,
  });
});

it('accepts explicitly correcting an old score without accepting it as the result', () => {
  const fixture = QUESTION_CASES.find((item) => item.id === 'giants-score');
  if (!fixture) throw new Error('missing fixture');
  const result: QuestionResult = {
    id: fixture.id,
    records: fixture.records,
    mode: 'scripted',
    status: 'done',
    answer:
      'The Giants finished 5–4 in 11 innings against the Cardinals. That 7–3 I gave you earlier was a batted-ball stat, not the score.',
    parts: [],
    toolCalls: ['web.search', 'web.fetch'].map((name) => ({
      name,
      status: 'succeeded',
      args: {},
      result: {},
    })),
    approvals: 0,
    saved: [],
    elapsedMs: 10,
    costUsd: 0,
    modelCalls: [],
    verification: [],
    failures: [],
  };
  expect(evaluateQuestion(fixture, result)).toEqual([]);
  expect(
    evaluateQuestion(fixture, {
      ...result,
      answer: 'Final in 11 innings: Giants 7–3 against the Cardinals. 5 hits and 4 walks.',
    }),
  ).not.toEqual([]);
});

it('rolls back conversation, task and tool state after capturing a result', async () => {
  const { sql } = await import('drizzle-orm');
  const counts = () =>
    db.execute(
      sql`SELECT (SELECT count(*)::int FROM messages) AS messages, (SELECT count(*)::int FROM tasks) AS tasks, (SELECT count(*)::int FROM tool_calls) AS calls`,
    );
  const before = await counts();
  const fixture = QUESTION_CASES.find((item) => item.id === 'giants-score');
  if (!fixture) throw new Error('missing fixture');
  const result = await runQuestion(db, fixture);
  expect(result.toolCalls).toHaveLength(2);
  expect(await counts()).toEqual(before);
});

it('distinguishes an unsaved-order disclosure from a false save claim', () => {
  const fixture = QUESTION_CASES.find((item) => item.id === 'order-missing-details');
  if (!fixture) throw new Error('missing fixture');
  const result: QuestionResult = {
    id: fixture.id,
    records: fixture.records,
    mode: 'live',
    status: 'done',
    answer:
      "I don't have your regular order from Neighborhood Pupuseria saved. Please tell me what you'd like me to remember for next time.",
    parts: [],
    toolCalls: [],
    approvals: 0,
    saved: [],
    elapsedMs: 10,
    costUsd: 0,
    modelCalls: [],
    verification: [],
    failures: [],
  };
  expect(evaluateQuestion(fixture, result)).toEqual([]);
  expect(
    evaluateQuestion(fixture, {
      ...result,
      answer: 'I have saved your regular order. What else should I remember?',
    }),
  ).not.toEqual([]);
});
