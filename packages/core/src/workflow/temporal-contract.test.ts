import { describe, expect, it } from 'vitest';
import { detectPersonalReadRequest } from './read-intent.js';
import { enforcePersonalReadResponse, enforceResponseContract } from './response-contract.js';

describe('unsupported temporal read periods', () => {
  it('returns a deterministic clarification before a broad calendar read or model answer', () => {
    const request = detectPersonalReadRequest(
      [{ role: 'user', content: 'What was on my calendar 3 years ago?' }],
      { now: new Date('2026-09-08T12:00:00.000Z'), timeZone: 'America/Los_Angeles' },
    );
    if (!request) throw new Error('Expected a calendar read request');
    const response = enforcePersonalReadResponse(request, []);
    expect(response).toMatchObject({ blocked: true, unsupported: ['calendar_read'] });
    expect(response.text).toMatch(/can’t safely search that calendar period/i);
    const drafted = enforceResponseContract('You had a meeting on Monday.', [], {
      readRequest: request,
    });
    expect(drafted.blocked).toBe(true);
    expect(drafted.text).toBe(response.text);
  });
});
