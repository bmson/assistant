import { latestLocation, loadConfig } from '@assistant/core';
import { appleDirections, type MapKitCredentials, type MapsFetch } from '@assistant/core/maps';
import type { OwnerContextRepository } from '@assistant/persistence';
import { z } from 'zod';
import { canUseOwnerCurrentLocation } from './current-location-access.js';
import { register } from './register.js';
import type { ToolRegistry } from './registry.js';

export function registerMapsTools(
  registry: ToolRegistry,
  deps: {
    credentials: MapKitCredentials;
    fetchImpl?: MapsFetch;
    /** Current-location origin source; defaults to the tool context's database. */
    ownerContext?: OwnerContextRepository;
  },
) {
  register(
    registry,
    {
      name: 'maps.directions',
      description:
        'Directions, travel time, and distance with live traffic, from Apple Maps. Omit `origin` to start from where the owner is right now. `destination` may be an address, a venue ("Oracle Park"), or a place from the calendar. Pass `arriveBy` for "when should I leave to be there at 3?" and `departAt` for a later trip; both are ISO 8601 instants. The chat draws the route on a map with an Open in Maps button, so the reply only needs the takeaway: how long, and when to leave or when you would arrive. Modes: driving (default), walking, cycling — Apple Maps has no transit directions here.',
      inputSchema: z.object({
        destination: z.string().min(2).max(200),
        origin: z
          .string()
          .max(200)
          .optional()
          .describe("Where the trip starts. Omit to use the owner's current location."),
        mode: z.enum(['driving', 'walking', 'cycling']).default('driving'),
        arriveBy: z.string().datetime({ offset: true }).optional(),
        departAt: z.string().datetime({ offset: true }).optional(),
      }),
      risk: (args, ctx) =>
        !args.origin?.trim() && !canUseOwnerCurrentLocation(ctx) ? 'forbidden' : 'autonomous',
      acceptsUntrustedInput: true,
      cacheTtlSeconds: 120,
      execute: async (args, ctx) => {
        let origin: { lat: number; lng: number } | string;
        let originLabel: string;
        const originIsCurrent = !args.origin;
        if (args.origin) {
          origin = args.origin;
          originLabel = args.origin;
        } else {
          if (!canUseOwnerCurrentLocation(ctx))
            return { error: 'An explicit trip origin is required for this request.' };
          const ping = await latestLocation(
            deps.ownerContext ?? ctx.db,
            ctx.agentId,
            loadConfig().LOCATION_RETENTION_DAYS,
          );
          if (!ping)
            return {
              error:
                'no recent location is on file — ask where the trip starts, then pass it as origin',
            };
          origin = { lat: Number(ping.lat), lng: Number(ping.lng) };
          originLabel = ping.label || 'Current location';
        }
        try {
          return await appleDirections({
            credentials: deps.credentials,
            origin,
            originLabel,
            originIsCurrent,
            destination: args.destination,
            mode: args.mode,
            ...(args.arriveBy ? { arriveBy: new Date(args.arriveBy) } : {}),
            ...(args.departAt && !args.arriveBy ? { departAt: new Date(args.departAt) } : {}),
            now: ctx.now(),
            signal: ctx.signal,
            ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
          });
        } catch (err) {
          return { error: `Apple Maps could not be reached: ${String(err)}` };
        }
      },
    },
    // Neither networkEgress nor returnsUntrustedContent, like weather.lookup:
    // the only host is Apple Maps, which no argument can change and no
    // attacker can observe, and the result is a route and place names from
    // Apple's own gazetteer rather than third-party prose.
    {},
  );
}
