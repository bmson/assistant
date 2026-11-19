import { describe, expect, it } from 'vitest';
import { requireQaOrigin } from './qa-installation.js';

describe('dedicated QA origin', () => {
  const origin = 'http://127.0.0.1:3107';

  it('uses only the explicitly configured loopback origin', () => {
    expect(requireQaOrigin(undefined, origin)).toBe(origin);
    expect(requireQaOrigin(origin, origin)).toBe(origin);
    expect(() => requireQaOrigin('http://127.0.0.1:3000', origin)).toThrow(/does not match/);
    expect(() => requireQaOrigin(origin, undefined)).toThrow(/dedicated local QA server/);
  });

  it.each([
    'https://assistant.example',
    'http://localhost:3107',
    'http://secret@example.test:3107',
    'http://127.0.0.1:3107/private',
    'http://127.0.0.1:3107?token=secret',
    'http://127.1:3107',
    'http://127.0.0.1',
  ])('refuses an origin outside the exact loopback contract (%s)', (value) => {
    expect(() => requireQaOrigin(undefined, value)).toThrow(/literal loopback HTTP origin/);
  });
});
