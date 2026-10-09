import { describe, expect, it, vi } from 'vitest';
import { registerWeatherTool } from './builtin/weather.js';
import { registerMapsTools } from './maps.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext } from './types.js';

describe('public provider and private current-location boundary', () => {
  it.each([
    { trust: 'unknown', tainted: false },
    { trust: 'known', tainted: false },
    { trust: 'owner', tainted: true },
  ] as const)(
    'requires an explicit place/origin for %j before any private read or provider call',
    async (scope) => {
      const getLatestLocation = vi.fn();
      const fetcher = vi.fn();
      const registry = new ToolRegistry();
      const ownerContext = { kind: 'owner-context-repository', getLatestLocation } as never;
      registerWeatherTool(registry, { ownerContext, fetchImpl: fetcher });
      registerMapsTools(registry, { ownerContext, credentials: {} as never, fetchImpl: fetcher });
      const ctx = {
        ...scope,
        agentId: 'owner',
        taskId: 'task',
        signal: new AbortController().signal,
        now: () => new Date(),
        db: {} as never,
        log: async () => {},
      } as ToolContext;
      for (const [name, args, explicit] of [
        ['weather.lookup', { place: '', days: 3 }, { place: 'Boston', days: 3 }],
        [
          'maps.directions',
          { destination: 'Boston', mode: 'driving' },
          { origin: 'New York', destination: 'Boston', mode: 'driving' },
        ],
      ] as const) {
        const tool = registry.get(name)?.tool;
        if (!tool || typeof tool.risk !== 'function')
          throw new Error('missing dynamic scope check');
        expect(tool.risk(args, ctx)).toBe('forbidden');
        expect(tool.risk(explicit, ctx)).toBe('autonomous');
        expect(await tool.execute(args, ctx)).toHaveProperty('error');
      }
      expect(getLatestLocation).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
