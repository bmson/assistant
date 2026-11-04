import { expect, it } from 'vitest';
import { assertReplayDatabaseTarget } from './harness.js';

it('fails closed when the postgres connection has no replay-safe database name', () => {
  expect(() => assertReplayDatabaseTarget(['127.0.0.1'], null)).toThrow();
  expect(() => assertReplayDatabaseTarget(['127.0.0.1'], '')).toThrow();
  expect(() => assertReplayDatabaseTarget(['127.0.0.1'], 'assistant')).toThrow();
  expect(() => assertReplayDatabaseTarget(['db.example.org'], 'assistant_test')).toThrow();
  expect(() => assertReplayDatabaseTarget(['localhost'], 'assistant_test')).not.toThrow();
});
