import type { PhoneCalendarCache, PhoneCalendarSharingState } from '@assistant/persistence';
import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../registry.js';
import { registerPhoneCalendarFallback } from './calendar.js';

const state: PhoneCalendarSharingState = {
  version: 1,
  ownerId: 'owner',
  publisherId: 'replacement-phone',
  generation: 9,
  enabled: true,
  consentVersion: 1,
  calendars: [{ id: 'work', name: 'Work', purpose: 'commitments' }],
  updatedAt: '2026-10-22T18:00:00.000Z',
};
describe('rollback bridge through actual calendar tools', () => {
  it('keeps selected phone calendars explicitly unavailable instead of claiming an empty/free calendar', async () => {
    const cacheGet = vi.fn(async () => ({
      result: { events: [{ summary: 'Unverified stale private event' }] },
    }));
    const cache: PhoneCalendarCache = {
      cacheGet,
      cachePut: vi.fn(),
      phoneCalendarCompatibility: {
        read: async (owner) => {
          expect(owner).toBe('owner');
          return { schema: 'sharing', state };
        },
      },
    };
    const registry = new ToolRegistry();
    registerPhoneCalendarFallback(registry, cache, 'cursor-test-secret', 'owner@example.com');
    for (const name of ['calendar.list_events', 'calendar.availability']) {
      const tool = registry.get(name)?.tool;
      if (!tool) throw new Error(`Missing ${name}`);
      const args = { timeMin: '2026-10-22T00:00:00Z', timeMax: '2026-10-23T00:00:00Z' };
      const result = (await tool.execute(tool.inputSchema.parse(args), {
        agentId: 'owner',
      } as never)) as Record<string, unknown>;
      expect(result.complete).toBe(false);
      expect(JSON.stringify(result)).toContain('Work (iPhone)');
      expect(JSON.stringify(result)).toContain('unavailable');
      expect(JSON.stringify(result)).not.toContain('Unverified stale private event');
    }
    expect(cacheGet).not.toHaveBeenCalled();
  });
});
